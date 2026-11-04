/** Target-aware follow-up guidance; never changes runtime actions or result schemas. */
import type { RuntimeAction } from "../runtime/runtime_stack_runner.mjs";
import type { RuntimePersistenceOutcome } from "../../runtime/lifecycle/persistence.mjs";

export const runtimeActionCopy = ({
  action,
  sqlite,
  hasApplicationLaunch,
  runtimeState,
}: {
  action: RuntimeAction;
  sqlite: boolean;
  hasApplicationLaunch: boolean;
  runtimeState: RuntimePersistenceOutcome<unknown>["runtimeState"] | undefined;
}) => ({
  lifecycleState: sqlite
    ? `SQLite file ${runtimeState === "running" ? "enabled" : runtimeState === "stopped" ? "paused" : "removed"}`
    : `runtime ${runtimeState}`,
  nextAction: {
    run:
      runtimeState === "removed"
        ? "The disposable runtime and its data were removed; the immutable baseline remains. Run rehearsal run to create a fresh runtime."
        : runtimeState === "stopped"
          ? sqlite
            ? `The SQLite sandbox file was paused with local changes preserved. Run rehearsal start${hasApplicationLaunch ? " or rehearsal open" : ""} to enable it again.`
            : `The runtime was stopped with its database and Storage changes preserved. Run rehearsal start${hasApplicationLaunch ? " or rehearsal open" : ""} to resume.`
          : hasApplicationLaunch
            ? "Next: run rehearsal open for hands-on testing, then rehearsal verify."
            : sqlite
              ? "The rehearsal command is complete; the SQLite sandbox file remains enabled. Next: run rehearsal verify or inspect the sandbox file. No application launch is configured."
              : "The rehearsal command is complete; the database remains running. Next: run rehearsal verify or inspect the local database. This database-only project has no application to open.",
    start: hasApplicationLaunch
      ? "Next: run rehearsal open for hands-on testing or rehearsal status."
      : sqlite
        ? "The SQLite sandbox file is enabled. Next: run rehearsal status or rehearsal verify; no application launch is configured."
        : "The database is running. Next: run rehearsal status or rehearsal verify; no application launch is configured.",
    migrate: "Next: run rehearsal verify to prove the current runtime.",
    reset: hasApplicationLaunch
      ? "Next: run rehearsal open or rehearsal verify."
      : "Next: run rehearsal verify or inspect the local database; no application launch is configured.",
    status: "Next: run rehearsal verify, reset, stop, or discard.",
    stop: sqlite
      ? "The SQLite sandbox file is paused. Pausing does not close other applications' connections. Run rehearsal start to enable it again."
      : "Next: run rehearsal start when you want to resume.",
    discard:
      "The disposable runtime was removed; the immutable baseline remains.",
    verify: sqlite
      ? "Next: continue testing, reset to the baseline, or pause the SQLite sandbox file with rehearsal stop."
      : "Next: continue testing, reset to the baseline, or stop the runtime.",
  }[action],
});
