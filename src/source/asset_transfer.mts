/** Stream only explicitly approved Supabase Storage objects into a baseline. */

const BUCKET = /^[a-z0-9][a-z0-9.-]{0,99}$/u;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const MAXIMUM_STORAGE_DEPTH = 64;
const MAXIMUM_STORAGE_PATH_BYTES = 4096;

export interface ApprovedAssetDeclaration {
  bucket: string;
  prefix: string;
  pathMapping?: string;
}

export interface ApprovedAsset {
  bucket: string;
  objectPath: string;
  contentType: string;
  content: AsyncGenerator<Buffer>;
}

type AssetPathMapper = (input: { mapping: string; value: string }) => unknown;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeBaseUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Asset reader URL is invalid.");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK.has(url.hostname))
  ) {
    throw new Error(
      "Asset reader URL must use HTTPS or a loopback HTTP endpoint.",
    );
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
};

const safePath = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${label} is unsafe.`);
  }
  if (Buffer.byteLength(value) > MAXIMUM_STORAGE_PATH_BYTES) {
    throw new Error(`${label} is too long.`);
  }
  return value;
};

const safeInventoryName = (value: unknown): string => {
  const name = safePath(value, "Storage inventory name");
  if (name.includes("/") || name.includes("\\")) {
    throw new Error("Storage inventory name is not a single path segment.");
  }
  return name;
};

const readError = (label: string, response: Response): Error =>
  new Error(
    `${label} failed with HTTP ${response.status}; response content was withheld.`,
  );

const canonicalContentType = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
    if (
      /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(
        mediaType,
      )
    ) {
      return mediaType;
    }
  }
  return "application/octet-stream";
};

const responseBody = async function* ({
  response,
  expectedBytes,
  maximumBytes,
}: {
  response: Response;
  expectedBytes: number | null;
  maximumBytes: number;
}): AsyncGenerator<Buffer> {
  if (!response.body) throw new Error("Storage object response has no body.");
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes)
      throw new Error("Storage object exceeded its reviewed size limit.");
    yield buffer;
  }
  if (expectedBytes !== null && bytes !== expectedBytes) {
    throw new Error("Storage object size changed during transfer.");
  }
};

export const streamApprovedSupabaseAssets = async function* ({
  baseUrl,
  token,
  declarations,
  fetchImplementation = fetch,
  maximumObjects = 10_000,
  maximumObjectBytes = 50 * 1024 * 1024,
  maximumTotalBytes = 2 * 1024 * 1024 * 1024,
  pathMapper,
}: {
  baseUrl: string;
  token: string;
  declarations: readonly ApprovedAssetDeclaration[];
  fetchImplementation?: typeof fetch;
  maximumObjects?: number;
  maximumObjectBytes?: number;
  maximumTotalBytes?: number;
  pathMapper?: AssetPathMapper;
}): AsyncGenerator<ApprovedAsset> {
  const endpoint = safeBaseUrl(baseUrl);
  if (typeof token !== "string" || token.length < 16) {
    throw new Error("A scoped Storage reader token is required.");
  }
  if (!Array.isArray(declarations) || declarations.length === 0) return;
  let objectCount = 0;
  let totalBytes = 0;
  const inventoryPaths = new Set<string>();
  for (const declaration of declarations) {
    if (!BUCKET.test(declaration.bucket ?? "")) {
      throw new Error("Approved Storage bucket is invalid.");
    }
    const approvedPrefix = safePath(
      declaration.prefix.replace(/\/$/u, ""),
      "Approved Storage prefix",
    );
    const prefixes: { path: string; depth: number }[] = [
      { path: approvedPrefix, depth: 0 },
    ];
    const scheduledPrefixes = new Set([approvedPrefix]);
    for (let prefixIndex = 0; prefixIndex < prefixes.length; prefixIndex += 1) {
      const prefix = prefixes[prefixIndex]!;
      let offset = 0;
      while (true) {
        const response = await fetchImplementation(
          `${endpoint}/storage/v1/object/list/${encodeURIComponent(declaration.bucket)}`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              prefix: prefix.path,
              limit: 100,
              offset,
              sortBy: { column: "name", order: "asc" },
            }),
          },
        );
        if (!response.ok) throw readError("Storage inventory", response);
        const inventory = await response.json();
        if (!Array.isArray(inventory)) {
          throw new Error("Storage inventory response is invalid.");
        }
        for (const objectValue of inventory) {
          if (!isObject(objectValue)) {
            throw new Error("Storage inventory entry is invalid.");
          }
          const object = objectValue;
          const entryName = safeInventoryName(object.name);
          const name = safePath(
            `${prefix.path}/${entryName}`,
            "Storage object path",
          );
          if (!name.startsWith(`${approvedPrefix}/`)) {
            throw new Error("Storage inventory escaped its approved prefix.");
          }
          const inventoryKey = `${declaration.bucket}\0${name}`;
          if (inventoryPaths.has(inventoryKey)) {
            throw new Error("Storage inventory returned a duplicate path.");
          }
          inventoryPaths.add(inventoryKey);
          objectCount += 1;
          if (objectCount > maximumObjects) {
            throw new Error(
              "Storage inventory exceeds its reviewed transfer boundary.",
            );
          }
          const directory = object.id === null && object.metadata === null;
          if (directory) {
            if (prefix.depth >= MAXIMUM_STORAGE_DEPTH) {
              throw new Error(
                "Storage inventory exceeds its safe folder depth.",
              );
            }
            if (scheduledPrefixes.has(name)) {
              throw new Error("Storage inventory returned a duplicate folder.");
            }
            scheduledPrefixes.add(name);
            prefixes.push({ path: name, depth: prefix.depth + 1 });
            continue;
          }
          const metadata = isObject(object.metadata) ? object.metadata : {};
          const expectedBytes = Number(metadata.size ?? metadata.contentLength);
          if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
            throw new Error("Storage inventory omitted an exact object size.");
          }
          if (expectedBytes > maximumObjectBytes) {
            throw new Error("Storage object exceeds its reviewed size limit.");
          }
          totalBytes += expectedBytes;
          if (totalBytes > maximumTotalBytes) {
            throw new Error(
              "Storage inventory exceeds its reviewed transfer boundary.",
            );
          }
          const encodedPath = name.split("/").map(encodeURIComponent).join("/");
          const download = await fetchImplementation(
            `${endpoint}/storage/v1/object/authenticated/${encodeURIComponent(declaration.bucket)}/${encodedPath}`,
            {
              headers: {
                authorization: `Bearer ${token}`,
                ...(typeof metadata.eTag === "string"
                  ? { "if-match": metadata.eTag }
                  : {}),
              },
            },
          );
          if (!download.ok)
            throw readError("Storage object transfer", download);
          const responseEtag = download.headers.get("etag");
          if (typeof metadata.eTag === "string") {
            if (!responseEtag) {
              throw new Error(
                "Storage transfer omitted the reviewed object version.",
              );
            }
            if (responseEtag !== metadata.eTag) {
              throw new Error(
                "Storage object changed between inventory and transfer.",
              );
            }
          }
          if (declaration.pathMapping && typeof pathMapper !== "function") {
            throw new Error(
              "Storage path mapping requires the package-owned privacy mapper.",
            );
          }
          const objectPath = declaration.pathMapping
            ? safePath(
                pathMapper!({
                  mapping: declaration.pathMapping,
                  value: name,
                }),
                "Mapped Storage object path",
              )
            : name;
          yield {
            bucket: declaration.bucket,
            objectPath,
            contentType: canonicalContentType(
              metadata.mimetype,
              download.headers.get("content-type"),
            ),
            content: responseBody({
              response: download,
              expectedBytes,
              maximumBytes: maximumObjectBytes,
            }),
          };
        }
        if (inventory.length < 100) break;
        offset += inventory.length;
      }
    }
  }
};
