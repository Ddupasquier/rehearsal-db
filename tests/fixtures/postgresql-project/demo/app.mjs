/** Ordinary synthetic application: health plus a real local-database observation. */
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import config from "../rehearsal.config.mjs";
import { demoObservationSql } from "./contract.mjs";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("The synthetic application needs its reviewed local port.");
}
const execute = (args) => {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      "The synthetic application could not inspect its owned database.",
    );
  }
  return result.stdout.trim();
};

createServer((request, response) => {
  if (request.url === "/health") {
    response.end("ready");
    return;
  }
  try {
    const container = execute([
      "ps",
      "--no-trunc",
      "--filter",
      `label=com.rehearsal-db.project=${config.runtime.projectId}`,
      "--format",
      "{{.ID}}",
    ]);
    if (!/^[a-f0-9]{64}$/u.test(container)) {
      throw new Error(
        "The synthetic application needs one exact owned container.",
      );
    }
    const observation = execute([
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
      demoObservationSql,
    ]);
    JSON.parse(observation);
    response.setHeader("content-type", "application/json");
    response.end(observation);
  } catch {
    response.statusCode = 500;
    response.end("Synthetic database observation unavailable.");
  }
}).listen(port, "127.0.0.1");
