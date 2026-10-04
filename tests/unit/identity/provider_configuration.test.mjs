import { describe, expect, it } from "vitest";
import {
  applySupabaseAuthenticationProviders,
  renderSupabaseAuthenticationProviders,
} from "../../../src/identity/provider_configuration.mjs";

const authentication = Object.freeze({
  enableLocalSignup: true,
  environmentFile: ".env.rehearsal-service.local",
  providers: Object.freeze([
    Object.freeze({
      name: "google",
      clientIdEnvironmentVariable: "REHEARSAL_GOOGLE_CLIENT_ID",
      clientSecretEnvironmentVariable: "REHEARSAL_GOOGLE_CLIENT_SECRET",
    }),
    Object.freeze({
      name: "github",
      clientIdEnvironmentVariable: "REHEARSAL_GITHUB_CLIENT_ID",
      clientSecretEnvironmentVariable: "REHEARSAL_GITHUB_CLIENT_SECRET",
    }),
  ]),
});

describe("Supabase authentication provider configuration", () => {
  it("renders provider declarations using only environment references and a local callback", () => {
    const source = renderSupabaseAuthenticationProviders({
      authentication,
      apiPort: 58_321,
    });

    expect(source).toContain("[auth.external.google]");
    expect(source).toContain("[auth.external.github]");
    expect(source).toContain('client_id = "env(REHEARSAL_GOOGLE_CLIENT_ID)"');
    expect(source).toContain('secret = "env(REHEARSAL_GITHUB_CLIENT_SECRET)"');
    expect(source).toContain(
      'redirect_uri = "http://127.0.0.1:58321/auth/v1/callback"',
    );
    expect(source).not.toMatch(/client-secret-value|project\.supabase\.co/iu);
  });

  it("leaves an unconfigured template unchanged and safely replaces compatible legacy providers", () => {
    const source = "[auth]\nenabled = true\nenable_signup = false\n";
    expect(
      applySupabaseAuthenticationProviders({
        source,
        authentication: null,
        apiPort: 58_321,
      }),
    ).toBe(source);
    const legacy = `${source}
[auth.external.google]
enabled = true
client_id = "env(OLD_GOOGLE_CLIENT_ID)"
secret = "env(OLD_GOOGLE_SECRET)"
redirect_uri = "http://127.0.0.1:54321/auth/v1/callback"
skip_nonce_check = false
email_optional = false
`;
    const generated = applySupabaseAuthenticationProviders({
      source: legacy,
      authentication,
      apiPort: 58_321,
    });
    expect(legacy).toContain("OLD_GOOGLE_SECRET");
    expect(generated.match(/\[auth\.external\.google\]/gu)).toHaveLength(1);
    expect(generated).not.toContain("OLD_GOOGLE_SECRET");
    expect(generated).toContain(
      'secret = "env(REHEARSAL_GOOGLE_CLIENT_SECRET)"',
    );
  });

  it("refuses ambiguous or safety-weakening legacy provider transitions", () => {
    const source = "[auth]\nenabled = true\nenable_signup = false\n";
    for (const [providerSource, expected] of [
      [
        `${source}\n[auth.external.google]\nenabled = true\nunknown = true\n`,
        "contains an unsupported setting",
      ],
      [
        `${source}\n[auth.external.google]\nenabled = true\nskip_nonce_check = true\n`,
        "skip_nonce_check setting must match its explicit declarative authentication option",
      ],
      [
        `${source}\n[auth.external.google]\nenabled = true\n[auth.external.google]\nenabled = false\n`,
        "declares auth.external.google more than once",
      ],
      [
        `${source}\n[auth.external.google.custom]\nenabled = true\n`,
        "unsupported nested auth.external.google",
      ],
    ]) {
      expect(() =>
        applySupabaseAuthenticationProviders({
          source: providerSource,
          authentication,
          apiPort: 58_321,
        }),
      ).toThrow(expected);
    }
  });

  it("preserves an explicitly reviewed nonce exception in the generated copy", () => {
    const reviewedAuthentication = {
      ...authentication,
      providers: authentication.providers.map((provider) =>
        provider.name === "google"
          ? { ...provider, skipNonceCheck: true, emailOptional: false }
          : provider,
      ),
    };
    const source = `[auth]
enable_signup = false

[auth.external.google]
enabled = true
client_id = "env(OLD_CLIENT_ID)"
secret = "env(OLD_SECRET)"
redirect_uri = "http://127.0.0.1:54321/auth/v1/callback"
skip_nonce_check = true
email_optional = false
`;

    const generated = applySupabaseAuthenticationProviders({
      source,
      authentication: reviewedAuthentication,
      apiPort: 58_321,
    });

    expect(generated).toContain("skip_nonce_check = true");
    expect(generated).not.toContain("OLD_SECRET");
  });

  it("enables signup only in the generated runtime and requires an exact auth setting", () => {
    const source = "[auth]\nenabled = true\nenable_signup = false\n";
    const generated = applySupabaseAuthenticationProviders({
      source,
      authentication,
      apiPort: 58_321,
    });

    expect(source).toContain("enable_signup = false");
    expect(generated).toContain("enable_signup = true");
    expect(() =>
      applySupabaseAuthenticationProviders({
        source: "[auth]\nenabled = true\n",
        authentication,
        apiPort: 58_321,
      }),
    ).toThrow("exactly one [auth] section");
  });
});
