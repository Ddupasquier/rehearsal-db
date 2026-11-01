import { describe, expect, it } from "vitest";
import {
  normalizeRuntimeMarkerProtocol,
  protectPostgresqlRuntimeMarker,
} from "../../../../dist/src/runtime/lifecycle/runtime_marker_protocol.mjs";
describe("retained PostgreSQL marker compatibility protocol", () => {
  const original = {
    formatVersion: 1,
    target: "postgresql",
    generationId: "generation",
    dataSha256: "a".repeat(64),
    image: "postgres:17-alpine",
    databasePassword: "synthetic-only-password",
  };
  it("preserves all fields while causing strict legacy target checks to refuse", () => {
    const guarded = protectPostgresqlRuntimeMarker(original);
    expect(guarded).toEqual({
      ...original,
      target: "postgresql-retired",
      containerRetirementProtocol: 1,
    });
    expect(guarded.target === "postgresql").toBe(false);
    expect(normalizeRuntimeMarkerProtocol(guarded)).toEqual({
      ...original,
      containerRetirementProtocol: 1,
    });
    expect(original.target).toBe("postgresql");
  });
  it.each([
    {},
    { target: "postgresql-retired" },
    { target: "postgresql-retired", containerRetirementProtocol: 2 },
    { target: "postgresql-retired", containerRetirementProtocol: "1" },
    { target: "postgresql", containerRetirementProtocol: 1 },
    { target: "supabase", containerRetirementProtocol: 1 },
    null,
    [],
  ])(
    "refuses malformed or unsupported retirement declarations where present",
    (value) => {
      if (value && value.target === undefined && !Array.isArray(value))
        expect(() => protectPostgresqlRuntimeMarker(value)).toThrow();
      else expect(normalizeRuntimeMarkerProtocol(value)).toBeNull();
    },
  );
  it("keeps ordinary Supabase and PostgreSQL markers unchanged", () => {
    expect(normalizeRuntimeMarkerProtocol(original)).toBe(original);
    const supabase = { target: "supabase", generationId: "generation" };
    expect(normalizeRuntimeMarkerProtocol(supabase)).toBe(supabase);
  });
});
