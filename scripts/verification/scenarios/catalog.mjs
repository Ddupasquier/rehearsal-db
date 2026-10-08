/** One catalog shared by individual scenario runs and the complete release gate. */

import { fileURLToPath } from "node:url";

const fixture = (filename) =>
  fileURLToPath(new URL(`../fixtures/${filename}`, import.meta.url));

export const verificationScenarios = Object.freeze([
  Object.freeze({ id: "onboarding", file: fixture("onboarding.mjs") }),
  Object.freeze({ id: "typescript", file: fixture("typescript.mjs") }),
  Object.freeze({ id: "privacy", file: fixture("privacy.mjs") }),
  Object.freeze({ id: "postgresql", file: fixture("postgresql.mjs") }),
  Object.freeze({ id: "dependent-target", file: fixture("dependent.mjs") }),
  Object.freeze({ id: "standalone", file: fixture("standalone.mjs") }),
  Object.freeze({ id: "supabase", file: fixture("supabase.mjs") }),
]);

export const findVerificationScenario = (id) =>
  verificationScenarios.find((scenario) => scenario.id === id);
