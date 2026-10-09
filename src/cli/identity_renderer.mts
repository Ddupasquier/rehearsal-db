/** Redacted terminal output for the interactive copied-account connection. */

import type { IdentityClaimResult } from "../identity/claim_contract.mjs";
import type { IdentityConnectionPreview } from "../identity/connect.mjs";

export const renderIdentityConnection = ({
  mode,
  preview,
  result,
}: {
  mode: "preview" | "connected" | "already-connected" | "cancelled";
  preview: IdentityConnectionPreview;
  result?: IdentityClaimResult;
}): string =>
  [
    `COPIED ACCOUNT — ${mode.replaceAll("-", " ").toUpperCase()}`,
    `Account label: ${preview.name}`,
    `Verified provider: ${preview.provider}`,
    `Data groups: ${preview.relationalGroups} relational; ${preview.nestedJsonGroups} nested JSON`,
    `Images: ${preview.assetScopes} reviewed Storage scope${preview.assetScopes === 1 ? "" : "s"}; ${preview.storagePathGroups} path reference group${preview.storagePathGroups === 1 ? "" : "s"}`,
    `Permissions: ${preview.claimKeys} reviewed claim${preview.claimKeys === 1 ? "" : "s"}; token hook ${preview.tokenHookConfigured ? "verified during connection" : "not configured"}`,
    `Immutable history: ${preview.preservedAuditGroups} reference group${preview.preservedAuditGroups === 1 ? "" : "s"} stays with the copied audit identity`,
    `Plan: ${preview.planDigest.slice(0, 12)}`,
    "",
    ...(mode === "preview"
      ? [
          "This changes only the disposable local sandbox.",
          "Edited or independent local account data will make the connection stop safely.",
          "Nothing has changed yet.",
        ]
      : mode === "cancelled"
        ? [
            "Nothing was changed. Your local database runtime is still available.",
          ]
        : mode === "already-connected"
          ? [
              "This copied account is already connected in the current local runtime.",
              "No transfer was repeated.",
            ]
          : [
              `Transferred images: ${result?.storageObjectsTransferred ?? 0}`,
              `Removed untouched signup defaults: ${result?.removedSignupDefaults ?? 0}`,
              "The copied account is connected and verified.",
              "Sign out and sign in once more so the application receives fresh role claims.",
            ]),
  ].join("\n");
