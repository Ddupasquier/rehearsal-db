/** Short explanatory screens for setup choices, without executing setup commands. */
import type { RehearsalCliFlags } from "../arguments.mjs";
import { REHEARSAL_NODE_LABEL } from "../../shared/node_runtime.mjs";
import { terminalStyle } from "./terminal.mjs";

export const renderGuidedNodeHelp = (
  version: string,
  flags: RehearsalCliFlags,
): string =>
  [
    "",
    terminalStyle(flags, "1", "SUPPORTED NODE.JS REQUIRED"),
    `This shell is using Node.js ${version}. Rehearsal has not changed your project.`,
    `Supported releases: ${REHEARSAL_NODE_LABEL}.`,
    "",
    "Recommended with nvm:",
    "  nvm install --lts",
    "  nvm use --lts",
    "",
    "Then reinstall Rehearsal in your scratch project and run npx rehearsal again.",
  ].join("\n");

export const renderSqliteBaselineHelp = (): string =>
  [
    "",
    "SQLITE BASELINE",
    "Review the configured source file and exhaustive KEEP/REPLACE column policy.",
    "Create a JSON ledger of the exact current SQL files already represented by that source.",
    "Then run: rehearsal baseline create --records=<configured-source.sqlite> --ledger=<ledger.json>",
    "See the package's docs/sqlite.md for the file format, bounds and recovery instructions.",
    "",
  ].join("\n");
