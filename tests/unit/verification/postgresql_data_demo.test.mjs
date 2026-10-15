import { describe, expect, it } from "vitest";
import { assertDemoObservation } from "../../fixtures/postgresql-project/demo/contract.mjs";

const observation = (rows, required) => ({
  publicRows: rows,
  nullDescriptions: required ? 0 : rows,
  reviewedDescriptions: required ? rows : 0,
  descriptionRequired: required,
  publicationRows: 1,
  fixtureRowsPreserved: true,
});

describe("data-shaped migration demonstration observations", () => {
  it("distinguishes a measured empty table from missing or unknown counts", () => {
    expect(
      assertDemoObservation(observation(0, false), {
        expectedRows: 0,
        descriptionRequired: false,
      }).publicRows,
    ).toBe(0);
    for (const value of [undefined, null, "0", false]) {
      expect(() =>
        assertDemoObservation(
          { ...observation(0, false), publicRows: value },
          {
            expectedRows: 0,
            descriptionRequired: false,
          },
        ),
      ).toThrow(/reviewed phase/u);
    }
  });
  it("requires real null-bearing preconditions and corrected values, not just a column", () => {
    for (const [rows, required] of [
      [0, false],
      [1, false],
      [0, true],
      [1, true],
    ]) {
      expect(() =>
        assertDemoObservation(observation(rows, required), {
          expectedRows: rows,
          descriptionRequired: required,
        }),
      ).not.toThrow();
    }
    for (const change of [
      { nullDescriptions: 1 },
      { reviewedDescriptions: 0 },
      { descriptionRequired: false },
      { publicationRows: 0 },
      { fixtureRowsPreserved: false },
    ]) {
      expect(() =>
        assertDemoObservation(
          { ...observation(1, true), ...change },
          {
            expectedRows: 1,
            descriptionRequired: true,
          },
        ),
      ).toThrow(/reviewed phase/u);
    }
  });
  it("refuses unreviewed expectation shapes", () => {
    for (const expectedRows of [-1, 2, null, "1"]) {
      expect(() =>
        assertDemoObservation(observation(1, true), {
          expectedRows,
          descriptionRequired: true,
        }),
      ).toThrow(/expectations/u);
    }
    expect(() =>
      assertDemoObservation(observation(1, true), {
        expectedRows: 1,
        descriptionRequired: "yes",
      }),
    ).toThrow(/expectations/u);
  });
});
