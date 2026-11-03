import { describe, expect, it } from "vitest";
import { parseApplicationCommand } from "../../../dist/src/shared/application_command.mjs";
import {
  applicationArgumentCases,
  invalidApplicationCommandCases,
} from "../../helpers/application_command_cases.mjs";

describe("configured application command argv", () => {
  it.each(applicationArgumentCases)("preserves $name", ({ source, args }) => {
    expect(parseApplicationCommand(`program ${source}`)).toEqual([
      "program",
      ...args,
    ]);
  });

  it("joins quoted and unquoted executable fragments", () => {
    expect(parseApplicationCommand("pro\"gra\"m'' first")).toEqual([
      "program",
      "first",
    ]);
  });

  it.each(invalidApplicationCommandCases)(
    "rejects $name",
    ({ source, error }) => {
      expect(() => parseApplicationCommand(source)).toThrow(
        `Application command ${error === "empty" ? "is empty." : "contains an unmatched quote."}`,
      );
    },
  );

  it("retains the proof command's failure label", () => {
    expect(() =>
      parseApplicationCommand('"" node', "Application proof command"),
    ).toThrow("Application proof command is empty.");
  });
});
