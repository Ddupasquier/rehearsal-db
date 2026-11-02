import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  REHEARSAL_EXIT_CODES,
  RehearsalError,
  createRehearsalResult,
  redactDiagnosticValue,
  renderHumanError,
  serializeRehearsalError,
} from "../../../dist/src/shared/diagnostics.mjs";
import {
  buildAuthenticationReview,
  buildBaselineScopeReview,
} from "../../../dist/src/runtime/lifecycle/project_review.mjs";
import {
  createAndActivateBaseline,
  removeBaselineArtifactRoot,
  verifyActiveBaseline,
} from "../../../dist/src/baseline/artifact.mjs";

const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await removeBaselineArtifactRoot({
      artifactRoot: join(root, ".rehearsal"),
    });
    await rm(root, { recursive: true, force: true });
  }
});

const canaries = {
  password: "never-print-this-password",
  serviceRoleKey: "sb_secret_never-print-this-key",
  databaseUrl: "postgresql://admin:secret@hosted.example/database",
  authorization: "Bearer secret-token",
  nested: { jwt: "eyJabcdefghijk.abcdefghijkl.abcdefghijkl" },
};

describe("Rehearsal diagnostics", () => {
  it("preserves real baseline and checksum failures plus unexpected internal faults", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "rehearsal-diagnostic-categories-"),
    );
    const artifactRoot = join(root, ".rehearsal");
    const generationId = "20260912T120000Z-aaaaaaaaaaaa";
    await createAndActivateBaseline({
      artifactRoot,
      generationId,
      metadata: {
        migrationCutoff: "20260911223000",
        migrationHistorySha256: "a".repeat(64),
        sanitizationPolicySha256: "b".repeat(64),
      },
      records: [{ table: "widgets", row: { id: "synthetic" } }],
    });
    roots.push(root);
    const manifestPath = join(
      artifactRoot,
      "generations",
      generationId,
      "baseline-manifest.json",
    );
    const manifest = await readFile(manifestPath);
    await chmod(manifestPath, 0o600);
    await writeFile(manifestPath, "[]\n");
    const baselineFailure = await verifyActiveBaseline({
      artifactRoot,
    }).catch((error) => error);
    expect(serializeRehearsalError(baselineFailure).error.category).toBe(
      "baseline_invalid",
    );
    await writeFile(manifestPath, manifest);
    const dataPath = join(
      artifactRoot,
      "generations",
      generationId,
      "sanitized-data.ndjson",
    );
    await chmod(dataPath, 0o600);
    await writeFile(dataPath, "tampered\n");
    const checksumFailure = await verifyActiveBaseline({ artifactRoot }).catch(
      (error) => error,
    );
    expect(serializeRehearsalError(checksumFailure).error.category).toBe(
      "baseline_checksum_mismatch",
    );
    expect(
      serializeRehearsalError(new Error("Synthetic unexpected fault.")).error
        .category,
    ).toBe("internal_failure");
    for (const [error, expectedExitCode] of [
      [baselineFailure, 4],
      [checksumFailure, 5],
      [new Error("Synthetic unexpected fault."), 10],
    ]) {
      const category = serializeRehearsalError(error).error.category;
      expect(REHEARSAL_EXIT_CODES[category]).toBe(expectedExitCode);
    }
  });

  it("publishes stable exit categories", () => {
    expect(REHEARSAL_EXIT_CODES).toEqual({
      success: 0,
      configuration_invalid: 2,
      unsafe_environment: 3,
      baseline_invalid: 4,
      baseline_checksum_mismatch: 5,
      migration_candidate_failure: 6,
      migration_verification_failure: 7,
      application_proof_failure: 8,
      runtime_dependency_failure: 9,
      internal_failure: 10,
      operation_cancelled: 130,
    });
  });

  it("serializes every public failure category with its stable exit code", () => {
    for (const [category, exitCode] of Object.entries(REHEARSAL_EXIT_CODES)) {
      if (category === "success") continue;
      const error = new RehearsalError({
        category,
        code: `TEST_${category.toUpperCase()}`,
        message: `Synthetic ${category}`,
        expected: "safe expected state",
        actual: "safe actual state",
        refused: "Synthetic action refused.",
      });
      const serialized = serializeRehearsalError(error);
      expect(error.exitCode).toBe(exitCode);
      expect(serialized.error.category).toBe(category);
      expect(serialized.error.code).toBe(`TEST_${category.toUpperCase()}`);
    }
  });

  it("redacts credentials, connection strings, tokens, and JWTs recursively", () => {
    const result = JSON.stringify(redactDiagnosticValue(canaries));
    for (const canary of [
      "never-print-this-password",
      "sb_secret_never-print-this-key",
      "admin:secret",
      "secret-token",
      "eyJabcdefghijk",
    ]) {
      expect(result).not.toContain(canary);
    }
  });

  it("uses one safe model for human and JSON failures", () => {
    const error = new RehearsalError({
      category: "unsafe_environment",
      code: "HOSTED_TARGET",
      message: `Refused ${canaries.databaseUrl}`,
      expected: "loopback",
      actual: canaries,
      refused: "Database restore was not started.",
      suggestions: ["Use an isolated local Supabase config."],
    });
    expect(error.exitCode).toBe(3);
    for (const debug of [false, true]) {
      const json = JSON.stringify(serializeRehearsalError(error, { debug }));
      const human = renderHumanError(error, { debug });
      expect(json).toContain("HOSTED_TARGET");
      expect(human).toContain("Database restore was not started");
      for (const canary of [
        "admin:secret",
        "never-print-this-password",
        "sb_secret_never-print-this-key",
        "secret-token",
        "eyJabcdefghijk",
      ]) {
        expect(`${json}${human}`).not.toContain(canary);
      }
    }
  });

  it("wraps successful machine output in a versioned envelope", () => {
    const result = createRehearsalResult({
      command: "doctor",
      status: "success",
      data: { state: "READY", credentials: canaries },
    });
    expect(result.schemaVersion).toBe(1);
    expect(result.rehearsalVersion).toBe(packageVersion);
    expect(result.data.state).toBe("READY");
    expect(JSON.stringify(result)).not.toContain("never-print-this-password");
  });

  it("retains non-secret safety metadata while redacting its nested values", () => {
    const result = createRehearsalResult({
      command: "doctor",
      status: "success",
      data: {
        ambientHostedVariables: {
          presentButQuarantined: ["SUPABASE_ACCESS_TOKEN"],
          note: "not inherited",
        },
      },
    });
    expect(result.data.ambientHostedVariables).toEqual({
      presentButQuarantined: ["SUPABASE_ACCESS_TOKEN"],
      note: "not inherited",
    });
  });

  it("preserves only the exact false privacy attestation, not arbitrary credential values", () => {
    expect(
      redactDiagnosticValue({ privacy: { credentialsIncluded: false } }),
    ).toEqual({ privacy: { credentialsIncluded: false } });
    for (const value of [
      true,
      null,
      "false",
      { password: canaries.password },
      [false],
      0,
      undefined,
    ]) {
      expect(
        redactDiagnosticValue({ privacy: { credentialsIncluded: value } }),
      ).toEqual({ privacy: { credentialsIncluded: "[REDACTED]" } });
    }
    for (const key of [
      "credentials",
      "CredentialsIncluded",
      "credentialsIncludedExtra",
      "password",
      "apiKey",
      "token",
    ]) {
      expect(redactDiagnosticValue({ [key]: false })).toEqual({
        [key]: "[REDACTED]",
      });
    }
  });

  it("keeps baseline and authentication privacy attestations in the public JSON envelope", () => {
    const review = buildBaselineScopeReview({
      provider: "postgresql",
      sourcePreparationConfigured: false,
      identityPolicyConfigured: false,
      baseline: {
        tableCounts: {},
        sanitizationPolicySha256: "a".repeat(64),
        storageAssets: {},
      },
      policy: { policyVersion: 1, tables: [] },
    });
    const authenticationReview = buildAuthenticationReview({
      provider: "postgresql",
      configuredProviders: [],
      declarativeProviders: [],
      callback: null,
      template: null,
      identityPolicyConfigured: false,
    });
    const decoded = JSON.parse(
      JSON.stringify(
        createRehearsalResult({
          command: "inspect baseline",
          status: "success",
          data: { review, authenticationReview, credentials: canaries },
        }),
      ),
    );
    expect(decoded.data.review.privacy).toEqual({
      rowValuesIncluded: false,
      credentialsIncluded: false,
      sourceContacted: false,
    });
    expect(decoded.data.authenticationReview.privacy).toEqual({
      credentialsIncluded: false,
      environmentFilesRead: false,
      authenticationAttempted: false,
    });
    expect(decoded.data.credentials).toBe("[REDACTED]");
    expect(JSON.stringify(decoded)).not.toContain(canaries.password);
  });
});
