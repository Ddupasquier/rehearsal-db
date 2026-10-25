import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const helper = fileURLToPath(
  new URL("../../../scripts/verification/owned_daemon.sh", import.meta.url),
);
const run = (source) =>
  spawnSync(
    "bash",
    [
      "-c",
      'set -euo pipefail; source "$1"; ' + source,
      "owned-daemon-test",
      helper,
    ],
    { encoding: "utf8", timeout: 5000, maxBuffer: 65536 },
  );

it("bounds graceful and forced phases using a deterministic child-state simulation", () => {
  const result = run(`
    clock=0; owned_daemon_now_ms() { printf '%s\\n' "$clock"; }
    calls=0; stage=live
    owned_daemon_state() { [[ $stage == done ]] && return 3; return 0; }
    kill() { printf '%s\\n' "$2"; [[ $2 == KILL ]] && stage=done; return 0; }
    sleep() { calls=$((calls+1)); clock=$((clock+100)); }
    owned_daemon_shutdown 999999 $$ /synthetic/daemon 0 42
    [[ $calls == 300 ]]
  `);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("TERM\nKILL\n");
});
it("refuses changed identity without signalling a foreign canary", () => {
  const result = run(`
    owned_daemon_now_ms() { printf '0\\n'; }
    owned_daemon_state() { return 1; }
    kill() { printf 'FOREIGN SIGNAL'; }
    if owned_daemon_shutdown 999999 $$ /synthetic/daemon 0 42; then exit 9; fi
  `);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
});
it("does not wait indefinitely when a forced termination is unacknowledged", () => {
  const result = run(`
    clock=0; owned_daemon_now_ms() { printf '%s\\n' "$clock"; }
    calls=0
    owned_daemon_state() { return 0; }
    kill() { return 0; }
    sleep() { calls=$((calls+1)); clock=$((clock+100)); }
    if owned_daemon_shutdown 999999 $$ /synthetic/daemon 0 42; then exit 9; fi
    [[ $calls == 320 ]]
  `);
  expect(result.status).toBe(0);
});
it.skipIf(process.platform !== "linux")(
  "reaps only the actual direct Linux child with matching proc identity",
  () => {
    const result = run(`
    executable=$(readlink -f "$(command -v sleep)")
    sleep 30 & pid=$!
    trap 'kill -KILL "$pid" 2>/dev/null || true' EXIT
    started=$(owned_daemon_capture "$pid" $$ "$executable" "$(id -u)")
    owned_daemon_shutdown "$pid" $$ "$executable" "$(id -u)" "$started"
    ! kill -0 "$pid" 2>/dev/null
  `);
    expect(result.status, result.stderr).toBe(0);
  },
);

it.each([0, 7])(
  "exposes cleanup failure while preserving original nonzero status %s",
  (original) => {
    const result = run(
      `owned_daemon_shutdown() { return 1; }; owned_daemon_cleanup_status ${original} false 999999 $$ /synthetic/daemon 0 42`,
    );
    expect(result.status).toBe(original || 1);
    expect(result.stderr).toContain(
      "Owned CI daemon cleanup could not be confirmed within its fixed bounds.",
    );
  },
);
it("preserves original failure after confirmed cleanup without a false cleanup error", () => {
  const result = run(
    `owned_daemon_shutdown() { return 0; }; owned_daemon_cleanup_status 7 false 999999 $$ /synthetic/daemon 0 42`,
  );
  expect(result.status).toBe(7);
  expect(result.stderr).toBe("");
});

it("includes metadata elapsed time rather than counting only sleeps", () => {
  const result = run(`
    clock=0; sleeps=0
    owned_daemon_now_ms() { printf '%s\\n' "$clock"; }
    owned_daemon_state() { clock=$((clock+16000)); return 0; }
    sleep() { sleeps=$((sleeps+1)); }
    kill() { printf '%s\\n' "$2"; }
    if owned_daemon_shutdown 999999 $$ /synthetic/daemon 0 42; then exit 9; fi
    [[ $sleeps == 0 ]]
  `);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("TERM\n");
});
it("refuses an existing PID directory whose stat is unavailable instead of treating it as exited", () => {
  const result = run(`
    root=$(mktemp -d)
    trap 'rm -rf "$root"' EXIT
    mkdir "$root/self" "$root/123"
    printf 'readable' > "$root/self/stat"
    if owned_daemon_snapshot 123 $$ /synthetic/daemon 0 "$root"; then exit 9; else [[ $? == 1 ]]; fi
  `);
  expect(result.status).toBe(0);
});
it("rejects capture metadata that arrives after its absolute one-second deadline", () => {
  const result = run(`
    root=$(mktemp -d)
    trap 'rm -rf "$root"' EXIT
    owned_daemon_now_ms() { if [[ -e "$root/late" ]]; then printf '1500\\n'; else printf '0\\n'; fi; }
    owned_daemon_snapshot() { touch "$root/late"; printf '42:live\\n'; }
    if owned_daemon_capture 123 $$ /synthetic/daemon 0; then exit 9; fi
  `);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
});
