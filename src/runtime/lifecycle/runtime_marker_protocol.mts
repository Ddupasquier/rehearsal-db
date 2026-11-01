/** Pure marker-version interpretation. No filesystem, target driver or lifecycle writes. */
export const normalizeRuntimeMarkerProtocol = (
  value: unknown,
): Readonly<Record<string, unknown>> | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const marker = value as Record<string, unknown>;
  if (marker.target === "postgresql-retired")
    return marker.containerRetirementProtocol === 1
      ? Object.freeze({ ...marker, target: "postgresql" })
      : null;
  if (Object.hasOwn(marker, "containerRetirementProtocol")) return null;
  return marker;
};
/** Raw guarded form makes strict older PostgreSQL target checks refuse before their reset fallback. */
export const protectPostgresqlRuntimeMarker = (
  value: unknown,
): Readonly<Record<string, unknown>> => {
  const normalized = normalizeRuntimeMarkerProtocol(value);
  if (!normalized || normalized.target !== "postgresql")
    throw new Error(
      "Unsupported retained PostgreSQL runtime marker protocol. Existing runtime data was preserved.",
    );
  return Object.freeze({
    ...(value as Record<string, unknown>),
    target: "postgresql-retired",
    containerRetirementProtocol: 1,
  });
};
