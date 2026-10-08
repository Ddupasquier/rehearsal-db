import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several suites compile or spawn the packed CLI. Bound worker pressure so
    // slower supported Node releases do not starve otherwise healthy processes.
    maxWorkers: 4,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
