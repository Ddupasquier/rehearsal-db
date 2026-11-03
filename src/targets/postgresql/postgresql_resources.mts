/** Exact successful listings prove absence; failed clients preserve runtime recovery. */
import { isDeepStrictEqual } from "node:util";
import type { ContainerRetirementVolume } from "../../runtime/resources/container_retirement.mjs";
import { assertDockerResourceLabels } from "../docker_resource_ownership.mjs";
import type {
  runPostgresqlCommand,
  PostgresqlCommandOptions,
} from "./postgresql_process.mjs";
export const createPostgresqlResourceManagement = ({
  runCommand,
  containerName,
  volumeName,
  projectId,
}: {
  runCommand: (
    command: string,
    args: readonly string[],
    options?: Pick<
      PostgresqlCommandOptions,
      "capture" | "purpose" | "allowFailure"
    >,
  ) => ReturnType<typeof runPostgresqlCommand>;
  containerName: string;
  volumeName: string;
  projectId: string;
}) => {
  const query = async (
    args: readonly string[],
    purpose: "metadata" | "cleanup" = "metadata",
  ) => {
    const result = await runCommand("docker", args, { capture: true, purpose });
    if (result.error || result.signal || result.status !== 0)
      throw new Error(
        "PostgreSQL resource observation or cleanup is unconfirmed; recovery was preserved.",
      );
    return result.stdout.trim();
  };
  const resourceIdentity = async (
    kind: "container" | "volume",
    name: string,
  ): Promise<string | null> => {
    const output = await query(
      kind === "container"
        ? [
            "container",
            "ls",
            "--all",
            "--no-trunc",
            "--filter",
            `name=^/${name}$`,
            "--format",
            "{{.ID}}",
          ]
        : [
            "volume",
            "ls",
            "--filter",
            `name=^${name}$`,
            "--format",
            "{{.Name}}",
          ],
    );
    if (!output) return null;
    if (
      kind === "container" ? !/^[a-f0-9]{64}$/u.test(output) : output !== name
    )
      throw new Error(
        "PostgreSQL resource identity is unconfirmed; recovery was preserved.",
      );
    return output;
  };
  const assertOwnedResource = async (
    kind: "container" | "volume",
    name: string,
  ): Promise<string | null> => {
    const identity = await resourceIdentity(kind, name);
    if (!identity) return null;
    const inspection = await query([
      kind,
      "inspect",
      "--format",
      kind === "container" ? "{{json .Config.Labels}}" : "{{json .Labels}}",
      identity,
    ]);
    assertDockerResourceLabels({
      labels: JSON.parse(inspection),
      expectedLabel: "com.rehearsal-db.project",
      projectId,
    });
    return identity;
  };
  const readOwnedVolume = async (): Promise<
    ContainerRetirementVolume & { labels: unknown }
  > => {
    const value = JSON.parse(
      await query([
        "volume",
        "inspect",
        "--format",
        '{"name":{{json .Name}},"createdAt":{{json .CreatedAt}},"driver":{{json .Driver}},"labels":{{json .Labels}}}',
        volumeName,
      ]),
    );
    if (
      !value ||
      value.name !== volumeName ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.driver !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(value.driver)
    )
      throw new Error(
        "PostgreSQL volume creation identity is unconfirmed; recovery was preserved.",
      );
    assertDockerResourceLabels({
      labels: value.labels,
      expectedLabel: "com.rehearsal-db.project",
      projectId,
    });
    return {
      name: value.name,
      createdAt: value.createdAt,
      driver: value.driver,
      labels: value.labels,
    };
  };
  const removeResources = async () => {
    await query(["info"]);
    const ownedContainer = await assertOwnedResource(
      "container",
      containerName,
    );
    const ownedVolume = (await resourceIdentity("volume", volumeName))
      ? await readOwnedVolume()
      : null;
    if (ownedContainer) {
      if (
        (await assertOwnedResource("container", containerName)) !==
        ownedContainer
      )
        throw new Error(
          "PostgreSQL container ownership changed; recovery was preserved.",
        );
      await query(["container", "rm", "--force", ownedContainer], "cleanup");
    }
    if (await resourceIdentity("container", containerName))
      throw new Error(
        "PostgreSQL container cleanup is unconfirmed; recovery was preserved.",
      );
    if (ownedVolume) {
      if (!isDeepStrictEqual(await readOwnedVolume(), ownedVolume))
        throw new Error(
          "PostgreSQL volume ownership changed; recovery was preserved.",
        );
      await query(["volume", "rm", "--force", ownedVolume.name], "cleanup");
    }
    if (await resourceIdentity("volume", volumeName))
      throw new Error(
        "PostgreSQL volume cleanup is unconfirmed; recovery was preserved.",
      );
  };
  return { assertOwnedResource, removeResources };
};
