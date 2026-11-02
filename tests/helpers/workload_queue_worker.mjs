/** IPC-only queue participant: no Docker, application or database operations. */
import { acquireWorkload } from "../../dist/src/runtime/resources/workload_queue.mjs";

const controller = new AbortController();
let lease;
process.on("message", async (message) => {
  if (message === "cancel") controller.abort(new Error("queue cancelled"));
  if (message === "release" && lease) {
    await lease.release();
    process.disconnect();
  }
});
try {
  lease = await acquireWorkload({
    command: "reset",
    waitTimeoutSeconds: 5,
    signal: controller.signal,
    onWaiting: () => process.send?.({ state: "waiting" }),
  });
  process.send?.({ state: "held", pid: process.pid });
} catch (error) {
  process.send?.({ state: "error", message: error.message });
  process.disconnect();
}
