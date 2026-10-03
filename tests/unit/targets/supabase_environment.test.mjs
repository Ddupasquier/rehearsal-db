import { describe, expect, it } from "vitest";
import { parseLocalSupabaseEnvironment } from "../../../src/targets/supabase_environment.mjs";

const localStatus = `API_URL=http://127.0.0.1:58321
DB_URL=postgresql://postgres:local-password@127.0.0.1:58322/postgres
PUBLISHABLE_KEY=local-publishable
SERVICE_ROLE_KEY=local-service-role
STUDIO_URL=http://127.0.0.1:58323
`;

describe("local Supabase environment", () => {
  it("keeps the validated local database connection for package-owned commands", () => {
    expect(parseLocalSupabaseEnvironment(localStatus)).toMatchObject({
      apiUrl: "http://127.0.0.1:58321",
      databaseUrl:
        "postgresql://postgres:local-password@127.0.0.1:58322/postgres",
      databaseHost: "127.0.0.1",
      databasePort: "58322",
      databaseName: "postgres",
      databaseUser: "postgres",
      databasePassword: "local-password",
    });
  });

  it("rejects hosted, incomplete, and non-PostgreSQL status values", () => {
    expect(() =>
      parseLocalSupabaseEnvironment(
        localStatus.replace("127.0.0.1:58322", "db.example.com:5432"),
      ),
    ).toThrow("non-local");
    expect(() =>
      parseLocalSupabaseEnvironment(localStatus.replace(/^DB_URL=.*\n/mu, "")),
    ).toThrow("omitted its database URL");
    expect(() =>
      parseLocalSupabaseEnvironment(
        localStatus.replace("postgresql://", "mysql://"),
      ),
    ).toThrow("non-local");
  });
});
