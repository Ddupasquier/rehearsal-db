/** Compatibility facade for the existing Prisma dependency-boundary contract. */
import { resolveNativeRuntimePackages } from "./native_toolchain_dependencies.mjs";
export {
  NATIVE_TOOLCHAIN_LIMITS as PRISMA_TOOLCHAIN_LIMITS,
  createNativeReadBudget as createPrismaReadBudget,
} from "./native_toolchain_dependencies.mjs";
export const invalidPrismaToolchain = () =>
  new Error(
    "Prisma requires an unchanged, bounded, regular project-local Prisma 7.10.1 runtime dependency closure and installed schema engine; no installation or fallback was attempted.",
  );
export const resolvePrismaRuntimePackages = async (
  root: string,
  roots: readonly string[],
) => {
  try {
    return await resolveNativeRuntimePackages(root, roots);
  } catch {
    throw invalidPrismaToolchain();
  }
};
