/** Verify declared proof services are explicitly enabled in the reviewed local template. */

import type { ApplicationRequiredService } from "../project/configuration_contract.mjs";

const SECTIONS: Readonly<
  Record<Exclude<ApplicationRequiredService, "database">, string>
> = {
  auth: "auth",
  storage: "storage",
  postgrest: "api",
  gateway: "api",
  mail: "inbucket|local_smtp",
  studio: "studio",
  realtime: "realtime",
  "edge-functions": "edge_runtime",
  analytics: "analytics",
  "image-transforms": "storage.image_transformation",
};

export const assertRequiredSupabaseServicesEnabled = ({
  template,
  requiredServices,
}: {
  readonly template: string;
  readonly requiredServices: readonly ApplicationRequiredService[];
}): void => {
  if (Buffer.byteLength(template) > 1024 * 1024)
    throw new Error("Supabase configuration exceeds its service-review bound.");
  for (const service of requiredServices) {
    if (service === "database") continue;
    const section = SECTIONS[service];
    let matchingSections = 0;
    let active = false;
    const declarations: string[] = [];
    for (const line of template.split(/\r?\n/u)) {
      const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line);
      if (header) {
        active = section.split("|").includes(header[1]!.trim());
        if (active) matchingSections += 1;
      } else if (active && /^\s*enabled\s*=/u.test(line)) {
        declarations.push(line.replace(/#.*$/u, "").trim());
      }
    }
    if (
      matchingSections !== 1 ||
      declarations.length !== 1 ||
      (declarations[0] !== "enabled = true" &&
        !/^enabled\s*=\s*true$/u.test(declarations[0]!))
    ) {
      throw new Error(
        `Required Supabase service ${service} is disabled or not explicitly enabled in the reviewed local [${section}] template. Review the configuration before starting; no services were started.`,
      );
    }
  }
};
