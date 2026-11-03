/** Reject ambiguous cross-provider ownership before touching a Docker resource. */

export const assertDockerResourceLabels = ({
  labels,
  expectedLabel,
  projectId,
}: {
  readonly labels: unknown;
  readonly expectedLabel:
    "com.supabase.cli.project" | "com.rehearsal-db.project";
  readonly projectId: string;
}): void => {
  if (labels === null || typeof labels !== "object" || Array.isArray(labels))
    throw new Error(
      "Docker resource ownership is missing or malformed; no resource was changed.",
    );
  const values = labels as Record<string, unknown>;
  if (
    values[expectedLabel] !== projectId ||
    ["com.supabase.cli.project", "com.rehearsal-db.project"].some(
      (key) => values[key] !== undefined && values[key] !== projectId,
    )
  )
    throw new Error(
      "Docker resource ownership is missing, conflicting, or foreign; no resource was changed.",
    );
};

export const assertOwnedSupabaseResourceInspection = ({
  output,
  count,
  projectId,
}: {
  readonly output: string;
  readonly count: number;
  readonly projectId: string;
}): void => {
  const lines = output.trim().split("\n").filter(Boolean);
  if (count > 1000 || lines.length !== count)
    throw new Error(
      "The bounded Supabase resource ownership inspection is incomplete.",
    );
  for (const line of lines) {
    let labels: unknown;
    try {
      labels = JSON.parse(line);
    } catch {
      throw new Error("Supabase resource ownership inspection is malformed.");
    }
    assertDockerResourceLabels({
      labels,
      expectedLabel: "com.supabase.cli.project",
      projectId,
    });
  }
};

type OwnedDockerResource = {
  readonly kind: "container" | "volume";
  readonly name: string;
  readonly id: string | null;
  readonly createdAt: string | null;
  readonly driver: string | null;
};
/** PostgreSQL's exact owned resources, on one already-reviewed local engine.
 * An inspect error is never absence. No raw provider output leaves this adapter.
 */
export const createPostgresqlResourceOwnership = ({
  projectId,
  run,
  engineIdentity,
}: {
  readonly projectId: string;
  readonly run: (args: readonly string[]) => {
    readonly status: number | null;
    readonly stdout: string;
    readonly error?: unknown;
  };
  readonly engineIdentity: () => string;
}) => {
  const refused = () =>
    new Error(
      "PostgreSQL resource presence or ownership is unavailable, changed or unverified; no further resource reuse or removal was authorized.",
    );
  const namePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/u;
  let identity: string | undefined;
  const revalidate = () => {
    try {
      const actual = engineIdentity();
      if (
        typeof actual !== "string" ||
        !actual ||
        actual.length > 8192 ||
        (identity !== undefined && actual !== identity)
      )
        throw refused();
      identity = actual;
    } catch {
      throw refused();
    }
  };
  const query = (args: readonly string[]) => {
    revalidate();
    let result;
    try {
      result = run(args);
    } catch {
      throw refused();
    }
    revalidate();
    if (result.error || typeof result.stdout !== "string") throw refused();
    return result;
  };
  const inspect = (
    kind: "container" | "volume",
    name: string,
  ): OwnedDockerResource | null => {
    if (!["container", "volume"].includes(kind) || !namePattern.test(name))
      throw refused();
    const inspection = query([
      kind,
      "inspect",
      "--format",
      kind === "container"
        ? '{"name":{{json .Name}},"id":{{json .Id}},"labels":{{json .Config.Labels}}}'
        : '{"name":{{json .Name}},"createdAt":{{json .CreatedAt}},"driver":{{json .Driver}},"labels":{{json .Labels}}}',
      name,
    ]);
    if (inspection.status !== 0) {
      const inventory = query(
        kind === "container"
          ? [
              "container",
              "ls",
              "--all",
              "--no-trunc",
              "--format",
              "{{.ID}}\t{{.Names}}",
            ]
          : ["volume", "ls", "--format", "{{.Name}}"],
      );
      if (
        inventory.status !== 0 ||
        Buffer.byteLength(inventory.stdout) > 1024 * 1024
      )
        throw refused();
      const text = inventory.stdout.replace(/\r\n/gu, "\n").replace(/\n$/u, ""),
        rows = text === "" ? [] : text.split("\n");
      if (rows.length > 10000) throw refused();
      const names = new Set<string>(),
        ids = new Set<string>();
      for (const row of rows) {
        const parts = row.split("\t"),
          candidate = kind === "container" ? parts[1] : parts[0];
        if (
          parts.length !== (kind === "container" ? 2 : 1) ||
          !candidate ||
          !namePattern.test(candidate) ||
          names.has(candidate)
        )
          throw refused();
        names.add(candidate);
        if (kind === "container") {
          const id = parts[0]!;
          if (!/^[a-f0-9]{64}$/u.test(id) || ids.has(id)) throw refused();
          ids.add(id);
        }
      }
      if (names.has(name)) throw refused();
      return null;
    }
    if (Buffer.byteLength(inspection.stdout) > 65536) throw refused();
    try {
      const value = JSON.parse(inspection.stdout);
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !==
          (kind === "container"
            ? "id,labels,name"
            : "createdAt,driver,labels,name") ||
        value.name !== (kind === "container" ? "/" + name : name)
      )
        throw refused();
      assertDockerResourceLabels({
        labels: value.labels,
        expectedLabel: "com.rehearsal-db.project",
        projectId,
      });
      if (kind === "container") {
        if (typeof value.id !== "string" || !/^[a-f0-9]{64}$/u.test(value.id))
          throw refused();
        return { kind, name, id: value.id, createdAt: null, driver: null };
      }
      if (
        typeof value.createdAt !== "string" ||
        value.createdAt.length > 128 ||
        !Number.isFinite(Date.parse(value.createdAt)) ||
        typeof value.driver !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value.driver)
      )
        throw refused();
      return {
        kind,
        name,
        id: null,
        createdAt: value.createdAt,
        driver: value.driver,
      };
    } catch {
      throw refused();
    }
  };
  const assertUnchanged = (expected: OwnedDockerResource) => {
    const current = inspect(expected.kind, expected.name);
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw refused();
  };
  return {
    inspect,
    assertUnchanged,
    remove: (expected: OwnedDockerResource) => {
      assertUnchanged(expected);
      const removed = query(
        expected.kind === "container"
          ? ["container", "rm", "--force", expected.id!]
          : ["volume", "rm", "--force", expected.name],
      );
      if (
        removed.status !== 0 ||
        inspect(expected.kind, expected.name) !== null
      )
        throw refused();
    },
    createVolume: (name: string): OwnedDockerResource => {
      if (inspect("volume", name) !== null) throw refused();
      const created = query([
        "volume",
        "create",
        "--label",
        `com.rehearsal-db.project=${projectId}`,
        name,
      ]);
      if (created.status !== 0 || created.stdout.trim() !== name)
        throw refused();
      const owned = inspect("volume", name);
      if (!owned) throw refused();
      return owned;
    },
  };
};
