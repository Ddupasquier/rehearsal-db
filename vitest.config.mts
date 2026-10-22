import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Private workflow tools have their own Node test runner. Only the maintained
    // product test tree belongs to this package gate.
    include: ["tests/**/*.test.mjs"],
    // Several suites compile or spawn the packed CLI. Bound worker pressure so
    // slower supported Node releases do not starve otherwise healthy processes.
    maxWorkers: 2,
    // Keep parallel suites from mutating one another's temporary ancestry.
    // Production input guards intentionally refuse detected ancestor changes.
    globalSetup: ["tests/helpers/unit_temporary_global.mjs"],
    setupFiles: ["tests/helpers/unit_temporary_worker.mjs"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
