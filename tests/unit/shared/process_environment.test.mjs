import { describe, expect, it } from "vitest";
import {
  assertLoopbackUrl,
  createCleanProcessEnvironment,
  isLoopbackUrl,
  pickEnvironmentVariables,
} from "../../../dist/src/shared/process_environment.mjs";

describe("process environment", () => {
  it("accepts loopback URLs and rejects remote or malformed values", () => {
    expect(isLoopbackUrl("http://localhost:5175/ready")).toBe(true);
    expect(isLoopbackUrl("https://127.0.0.1:54321")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:3000")).toBe(true);
    expect(isLoopbackUrl("https://example.com")).toBe(false);
    expect(isLoopbackUrl("not-a-url")).toBe(false);
    expect(() =>
      assertLoopbackUrl("Application URL", "https://example.com"),
    ).toThrow("Application URL must use a loopback URL");
  });

  it("copies only named, defined environment values", () => {
    expect(
      pickEnvironmentVariables({ KEEP: "yes", OMIT: undefined, SECRET: "no" }, [
        "KEEP",
        "OMIT",
      ]),
    ).toEqual({ KEEP: "yes" });
  });

  it("builds a minimal environment and omits undefined overrides", () => {
    expect(
      createCleanProcessEnvironment({
        inheritedEnvironment: {
          PATH: "/usr/bin",
          SAFE_EXTRA: "copied",
          UNLISTED_SECRET: "hidden",
        },
        passthroughKeys: ["SAFE_EXTRA"],
        overrides: {
          DATABASE_URL: "postgresql://localhost/rehearsal",
          REMOVE_ME: undefined,
        },
      }),
    ).toEqual({
      PATH: "/usr/bin",
      SAFE_EXTRA: "copied",
      DATABASE_URL: "postgresql://localhost/rehearsal",
    });
  });

  it("copies Windows infrastructure case-insensitively without credentials", () => {
    expect(
      createCleanProcessEnvironment({
        platform: "win32",
        inheritedEnvironment: {
          Path: "C:\\Windows\\System32",
          SYSTEMROOT: "C:\\Windows",
          windir: "C:\\Windows",
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
          pathext: ".COM;.EXE;.BAT;.CMD",
          userprofile: "C:\\Users\\fixture",
          appdata: "C:\\Users\\fixture\\AppData\\Roaming",
          localappdata: "C:\\Users\\fixture\\AppData\\Local",
          database_url: "not-inherited",
          SUPABASE_ACCESS_TOKEN: "not-inherited",
          NODE_OPTIONS: "not-inherited",
          NPM_CONFIG_TOKEN: "not-inherited",
          DOCKER_AUTH_CONFIG: "not-inherited",
        },
      }),
    ).toEqual({
      PATH: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      USERPROFILE: "C:\\Users\\fixture",
      APPDATA: "C:\\Users\\fixture\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
    });
  });

  it("emits one Windows key per name and applies explicit overrides last", () => {
    expect(
      createCleanProcessEnvironment({
        platform: "win32",
        inheritedEnvironment: {
          PATH: "canonical",
          Path: "duplicate",
          SYSTEMROOT: "inherited",
          CUSTOM: "explicitly-allowed",
        },
        passthroughKeys: ["Path", "custom"],
        overrides: {
          path: "override",
          SystemRoot: undefined,
          DATABASE_URL: "postgresql://localhost/explicit-local-target",
        },
      }),
    ).toEqual({
      PATH: "override",
      SystemRoot: "inherited",
      custom: "explicitly-allowed",
      DATABASE_URL: "postgresql://localhost/explicit-local-target",
    });
  });

  it("preserves POSIX case-sensitive allowlisting and excludes Windows-only keys", () => {
    for (const platform of ["linux", "darwin"]) {
      expect(
        createCleanProcessEnvironment({
          platform,
          inheritedEnvironment: {
            Path: "not-PATH",
            PATH: "/usr/bin",
            SystemRoot: "not-inherited",
            ComSpec: "not-inherited",
            APPDATA: "not-inherited",
            HOME: "/home/fixture",
            DATABASE_URL: "not-inherited",
          },
        }),
      ).toEqual({ PATH: "/usr/bin", HOME: "/home/fixture" });
    }
  });
});
