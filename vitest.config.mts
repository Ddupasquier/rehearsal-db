import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Private workflow tools have their own Node test runner. Only the maintained
    // product test tree belongs to this package gate.
    include: ["tests/**/*.test.mjs"],
    // Several suites compile or spawn the packed CLI. Bound worker pressure so
    // slower supported Node releases do not starve otherwise healthy processes.
    maxWorkers: 2,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
