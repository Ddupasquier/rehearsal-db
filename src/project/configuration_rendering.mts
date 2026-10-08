/** Render reviewed starter configurations without reading or writing a project. */

import type { DetectedProject } from "./project_detection.mjs";

export const renderDetectedConfig = (
  detected: DetectedProject,
  {
    applicationUrl = "http://localhost:5175",
    ports = { api: 58321, database: 58322, studio: 58323 },
  }: {
    applicationUrl?: string;
    ports?: { api: number; database: number; studio: number };
  } = {},
): string =>
  `// @ts-check
/**
 * Rehearsal configuration for ${detected.projectName}.
 * Generated from this project by \`npx rehearsal\` and safe to commit.
 * Review the CHECK comments. Keep passwords, tokens, and production URLs out of this file.
 * Docs: https://github.com/Ddupasquier/rehearsal-db/blob/main/docs/configuration.md
 */
import { defineRehearsalConfig } from "@rehearsal-db/core";

export default defineRehearsalConfig({
	// Configuration format. Rehearsal will explain if an upgrade is ever needed.
	schemaVersion: 1,
	// Stable local name used in Rehearsal labels and reports.
	project: { name: ${JSON.stringify(detected.projectName)} },

	// Project files Rehearsal reads. Every path stays inside this repository.
	supabase: {
		workdir: ".",
		migrationDirectory: "supabase/migrations",
		rehearsalConfig: "infrastructure/rehearsal/supabase/config.toml",
		runtimeWorkdir: ".rehearsal/runtime",

		// Optional local OAuth connection. Secrets stay in the ignored owner-only file.
		// Register http://127.0.0.1:${ports.api}/auth/v1/callback with the provider.
		// authentication: {
		// 	enableLocalSignup: true,
		// 	environmentFile: ".env.rehearsal-service.local",
		// 	providers: [
		// 		{
		// 			name: "google",
		// 			clientIdEnvironmentVariable: "REHEARSAL_GOOGLE_CLIENT_ID",
		// 			clientSecretEnvironmentVariable: "REHEARSAL_GOOGLE_CLIENT_SECRET",
		// 			skipNonceCheck: false,
		// 			emailOptional: false,
		// 		},
		// 	],
		// },
	},

	// Immutable local baseline files. Rehearsal never reads production on your behalf.
	baseline: {
		artifactDirectory: ".rehearsal",
		sanitizationPolicy: "infrastructure/rehearsal/sanitization-policy.json",
	},

	// Optional source refresh. Enable only after reviewing docs/standalone-workflow.md.
	// Credentials are read from the environment named by source-access-policy.json.
	// preparation: {
	// 	sourcePolicy: "infrastructure/rehearsal/source-access-policy.json",
	// 	privacyKey: ".rehearsal/secrets/privacy.key",
	// 	batchRows: 500,
	// 	maximumRows: 1000000,
	// 	maximumBytes: 2147483648,
	// 	diskHeadroomBytes: 67108864,
	// },
	// Optional reviewed schemas/extensions/triggers/local-only rows.
	// runtimePolicy: "infrastructure/rehearsal/runtime-policy.json",
	// Optional copied-account association. The JSON stores only reviewed matcher hashes;
	// raw emails/subjects and provider credentials stay in ignored environment files.
	// identityPolicy: "infrastructure/rehearsal/identity-policy.json",

	// Reuse any running Docker-compatible engine; start Colima only when needed.
	containerRuntime: {
		autoStartColima: true,
	},

	// Keep this many baseline generations, always including the active one.
	cleanup: {
		retainBaselineGenerations: 2,
	},

	// Optional: manage another isolated database as part of the same rehearsal.
	// Give that database its own complete config, ports, project ID, and .rehearsal folder.
	// dependentTargets: [
	// 	{
	// 		name: "publication-api",
	// 		configPath: "rehearsal.publication.config.mjs",
	// 		prepareCommand: "npm run rehearsal:prepare-publication",
	// 	},
	// ],

	application: {
		// CHECK: commands detected from package.json. Change them if they are not correct.
		startCommand: ${JSON.stringify(detected.applicationCommand)},
		proofCommand: ${JSON.stringify(detected.verificationCommand)},
		environmentFile: ".rehearsal/runtime.env",
		// Map generated local runtime values directly into the normal app command.
		// environmentVariables: { DATABASE_URL: "primary:DATABASE_URL" },
		// Required by \`rehearsal open\`; use a route that responds only when the app is ready.
		readiness: { url: ${JSON.stringify(applicationUrl)}, expectedStatus: 200, timeoutSeconds: 30 },
		// Add at least one real positive and one negative before enabling HTTP proofs.
		// httpProofs: [],
		// Optional project-specific restore hook:
		// runtimeAdapter: "infrastructure/rehearsal/runtime-adapter.mjs",
	},

	// Disposable local runtime identity, URL, and dedicated ports.
	runtime: {
		target: "supabase",
		applicationUrl: ${JSON.stringify(applicationUrl)},
		projectId: "${detected.projectName}-rehearsal",
		apiPort: ${ports.api},
		databasePort: ${ports.database},
		studioPort: ${ports.studio},
	},

	// Only local runtime URLs are accepted; common hosted credentials are quarantined.
	safety: {
		allowedHosts: ["127.0.0.1", "::1", "localhost"],
		blockedEnvironmentVariables: [
			"SUPABASE_ACCESS_TOKEN",
			"SUPABASE_DB_PASSWORD",
			"SUPABASE_PROJECT_ID",
		],
		hostedAccess: "disabled",
		outboundNetwork: "deny",
	},
});
`.replaceAll("\t", "  ");

export const renderDetectedPostgresqlConfig = (
  detected: DetectedProject,
  { applicationUrl = "http://localhost:5175", databasePort = 58322 } = {},
): string =>
  `// @ts-check
/**
 * Rehearsal configuration for ${detected.projectName}.
 * Generated from this project by \`npx rehearsal\` and safe to commit.
 * Review the CHECK comments. Keep passwords, tokens, and production URLs out of this file.
 * Docs: https://github.com/Ddupasquier/rehearsal-db/blob/main/docs/configuration.md
 */
import { defineRehearsalConfig } from "@rehearsal-db/core";

export default defineRehearsalConfig({
	// Configuration format. Rehearsal will explain if an upgrade is ever needed.
	schemaVersion: 1,
	// Stable local name used in Rehearsal labels and reports.
	project: { name: ${JSON.stringify(detected.projectName)} },

	// Disposable PostgreSQL settings. The image must already exist locally.
	postgresql: {
		migrationDirectory: ${JSON.stringify(detected.postgresqlMigrationDirectory)},
		runtimeWorkdir: ".rehearsal/runtime",
		image: "postgres:17-alpine",
		database: "postgres",
		user: "postgres",
	},

	// Immutable local baseline files. Rehearsal never reads production on your behalf.
	baseline: {
		artifactDirectory: ".rehearsal",
		sanitizationPolicy: "infrastructure/rehearsal/sanitization-policy.json",
	},

	// Optional source refresh. Enable only after reviewing docs/standalone-workflow.md.
	// Credentials are read from the environment named by source-access-policy.json.
	// preparation: {
	// 	sourcePolicy: "infrastructure/rehearsal/source-access-policy.json",
	// 	privacyKey: ".rehearsal/secrets/privacy.key",
	// 	batchRows: 500,
	// 	maximumRows: 1000000,
	// 	maximumBytes: 2147483648,
	// 	diskHeadroomBytes: 67108864,
	// },
	// Optional reviewed schemas/extensions/triggers/local-only rows.
	// runtimePolicy: "infrastructure/rehearsal/runtime-policy.json",
	// Optional copied-account association. The JSON stores only reviewed matcher hashes;
	// raw emails/subjects and provider credentials stay in ignored environment files.
	// identityPolicy: "infrastructure/rehearsal/identity-policy.json",

	// Reuse any running Docker-compatible engine; start Colima only when needed.
	containerRuntime: {
		autoStartColima: true,
	},

	// Keep this many baseline generations, always including the active one.
	cleanup: {
		retainBaselineGenerations: 2,
	},

	// Optional: manage another isolated database as part of the same rehearsal.
	// Give that database its own complete config, ports, project ID, and .rehearsal folder.
	// dependentTargets: [
	// 	{
	// 		name: "publication-api",
	// 		configPath: "rehearsal.publication.config.mjs",
	// 		prepareCommand: "npm run rehearsal:prepare-publication",
	// 	},
	// ],

	application: {
		// CHECK: commands detected from package.json. Change them if they are not correct.
		startCommand: ${JSON.stringify(detected.applicationCommand)},
		proofCommand: ${JSON.stringify(detected.verificationCommand)},
		environmentFile: ".rehearsal/runtime.env",
		// Map generated local runtime values directly into the normal app command.
		// environmentVariables: { DATABASE_URL: "primary:DATABASE_URL" },
		// Required by \`rehearsal open\`; use a route that responds only when the app is ready.
		readiness: { url: ${JSON.stringify(applicationUrl)}, expectedStatus: 200, timeoutSeconds: 30 },
		// Add at least one real positive and one negative before enabling HTTP proofs.
		// httpProofs: [],
		// Optional project-specific restore hook:
		// runtimeAdapter: "infrastructure/rehearsal/runtime-adapter.mjs",
	},

	// Disposable local runtime identity, URL, and dedicated database port.
	runtime: {
		target: "postgresql",
		applicationUrl: ${JSON.stringify(applicationUrl)},
		projectId: "${detected.projectName}-rehearsal",
		databasePort: ${databasePort},
	},

	// Only local runtime URLs are accepted; common hosted credentials are quarantined.
	safety: {
		allowedHosts: ["127.0.0.1", "::1", "localhost"],
		blockedEnvironmentVariables: [
			"DATABASE_URL",
			"PGHOST",
			"PGPASSWORD",
			"PGPORT",
			"PGUSER",
		],
		hostedAccess: "disabled",
		outboundNetwork: "deny",
	},
});
`.replaceAll("\t", "  ");
