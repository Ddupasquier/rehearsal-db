/** Preserve the exact Prisma profile over the shared native execution dependency owner. */
import { dirname, join } from "node:path";
import { inspectNativeToolchain } from "./native_toolchain.mjs";
import { invalidPrismaToolchain } from "./prisma_toolchain_dependencies.mjs";
export const inspectPrismaToolchain = async ({
  projectRoot,
  packageDirectory,
}: {
  projectRoot: string;
  packageDirectory: string;
}) => {
  try {
    const result = await inspectNativeToolchain({
      projectRoot,
      profiles: [
        {
          label: "prisma",
          directory: packageDirectory,
          name: "prisma",
          version: "7.10.1",
          bin: { key: "prisma", value: "build/index.js" },
        },
        {
          label: "engines",
          directory: join(dirname(packageDirectory), "@prisma/engines"),
          name: "@prisma/engines",
          version: "7.10.1",
          nativePattern: /^schema-engine-[a-z0-9_.-]+(?:\.exe)?$/u,
        },
      ],
    });
    return Object.freeze({
      sha256: result.sha256,
      cliPath: result.entrypoints.get("prisma")!.cliPath!,
      enginePath: result.entrypoints.get("engines")!.nativePath!,
    });
  } catch {
    throw invalidPrismaToolchain();
  }
};
