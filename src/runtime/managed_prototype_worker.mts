/** Fixed synthetic worker, deliberately incapable of executing requests or SQL. */
import { createHash } from "node:crypto";
let bytes = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  bytes += String(chunk);
  if (bytes.length > 4096) process.exit(2);
}
try {
  const request = JSON.parse(bytes) as { scenario: string; fixture: unknown[] };
  if (request.scenario === "worker-loss") process.exit(2);
  if (request.scenario === "timeout") {
    await new Promise((done) => setTimeout(done, 5000));
    process.exit(2);
  }
  if (!Array.isArray(request.fixture) || request.fixture.length !== 100)
    process.exit(2);
  process.stdout.write(
    JSON.stringify({
      rows: request.fixture.length,
      sha256: createHash("sha256")
        .update(JSON.stringify(request.fixture))
        .digest("hex"),
    }),
  );
} catch {
  process.exitCode = 2;
}
