/** Compare local application endpoints with every native service in one reviewed graph. */
import type { NormalizedRehearsalConfig } from "../../project/configuration.mjs";

export const assertRuntimeTopologyApplicationPorts = (
  targets: readonly {
    readonly name: string;
    readonly config: NormalizedRehearsalConfig;
  }[],
): void => {
  const services = targets.flatMap((target) =>
    Object.entries(target.config.runtime.ports).map(([kind, port]) => ({
      target: target.name,
      kind,
      port,
    })),
  );
  for (const target of targets) {
    const endpoints = [
      {
        path: "runtime.applicationUrl",
        url: target.config.runtime.applicationUrl,
      },
      ...(target.config.application.readiness
        ? [
            {
              path: "application.readiness.url",
              url: target.config.application.readiness.url,
            },
          ]
        : []),
      ...target.config.profiles.flatMap((profile, index) =>
        profile.applicationUrl === null
          ? []
          : [
              {
                path: `profiles[${index}].applicationUrl`,
                url: profile.applicationUrl,
              },
            ],
      ),
    ];
    for (const endpoint of endpoints) {
      const url = new URL(endpoint.url);
      const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      const conflict = services.find((service) => service.port === port);
      if (conflict)
        throw new Error(
          `Application endpoint ${target.name} ${endpoint.path} conflicts with configured ${conflict.target} ${conflict.kind} port ${port}. Review the complete topology before starting a runtime.`,
        );
    }
  }
};
