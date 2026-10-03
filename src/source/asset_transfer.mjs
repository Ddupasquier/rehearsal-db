/** Stream only explicitly approved Supabase Storage objects into a baseline. */

const BUCKET = /^[a-z0-9][a-z0-9.-]{0,99}$/u;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

const safeBaseUrl = (value) => {
  let url;
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

const safePath = (value, label) => {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${label} is unsafe.`);
  }
  return value;
};

const readError = (label, response) =>
  new Error(
    `${label} failed with HTTP ${response.status}; response content was withheld.`,
  );

const responseBody = async function* ({
  response,
  expectedBytes,
  maximumBytes,
}) {
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
}) {
  const endpoint = safeBaseUrl(baseUrl);
  if (typeof token !== "string" || token.length < 16) {
    throw new Error("A scoped Storage reader token is required.");
  }
  if (!Array.isArray(declarations) || declarations.length === 0) return;
  let objectCount = 0;
  let totalBytes = 0;
  for (const declaration of declarations) {
    if (!BUCKET.test(declaration.bucket ?? "")) {
      throw new Error("Approved Storage bucket is invalid.");
    }
    const prefix = safePath(
      declaration.prefix.replace(/\/$/u, ""),
      "Approved Storage prefix",
    );
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
            prefix,
            limit: 100,
            offset,
            sortBy: { column: "name", order: "asc" },
          }),
        },
      );
      if (!response.ok) throw readError("Storage inventory", response);
      const inventory = await response.json();
      if (!Array.isArray(inventory))
        throw new Error("Storage inventory response is invalid.");
      for (const object of inventory) {
        const name = safePath(
          `${prefix}/${object.name}`,
          "Storage object path",
        );
        if (!name.startsWith(`${prefix}/`))
          throw new Error("Storage inventory escaped its approved prefix.");
        const expectedBytes = Number(
          object.metadata?.size ?? object.metadata?.contentLength,
        );
        if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
          throw new Error("Storage inventory omitted an exact object size.");
        }
        if (expectedBytes > maximumObjectBytes) {
          throw new Error("Storage object exceeds its reviewed size limit.");
        }
        objectCount += 1;
        totalBytes += expectedBytes;
        if (objectCount > maximumObjects || totalBytes > maximumTotalBytes) {
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
              ...(object.metadata?.eTag
                ? { "if-match": object.metadata.eTag }
                : {}),
            },
          },
        );
        if (!download.ok) throw readError("Storage object transfer", download);
        const responseEtag = download.headers.get("etag");
        if (object.metadata?.eTag) {
          if (!responseEtag) {
            throw new Error(
              "Storage transfer omitted the reviewed object version.",
            );
          }
          if (responseEtag !== object.metadata.eTag) {
            throw new Error(
              "Storage object changed between inventory and transfer.",
            );
          }
        }
        yield {
          bucket: declaration.bucket,
          objectPath: name,
          contentType:
            download.headers.get("content-type") ??
            object.metadata?.mimetype ??
            "application/octet-stream",
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
};
