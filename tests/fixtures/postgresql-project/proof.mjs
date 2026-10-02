import { spawnSync } from "node:child_process";
import config from "./rehearsal.config.mjs";

const projectId = config.runtime.projectId;
const container = spawnSync(
  "docker",
  [
    "ps",
    "--filter",
    `label=com.rehearsal-db.project=${projectId}`,
    "--format",
    "{{.Names}}",
  ],
  { encoding: "utf8" },
).stdout.trim();
const result = spawnSync(
  "docker",
  [
    "exec",
    container,
    "psql",
    "--quiet",
    "--no-align",
    "--tuples-only",
    "--username",
    "postgres",
    "--dbname",
    "postgres",
    "--command",
    "select count(*) = 1 and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'widgets' and column_name = 'description') from public.widgets;",
  ],
  { encoding: "utf8" },
);
if (result.status !== 0 || result.stdout.trim() !== "t") {
  throw new Error(result.stderr || "The PostgreSQL fixture proof failed.");
}
console.log("PostgreSQL fixture proof passed.");
