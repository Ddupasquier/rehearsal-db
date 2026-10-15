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
