/** Typed contract shared by identity policy, planning, and execution stages. */

export const SUPPORTED_IDENTITY_PROVIDERS = Object.freeze([
  "email",
  "github",
  "google",
] as const);

export type JsonObject = Record<string, unknown>;
export type IdentityProvider = (typeof SUPPORTED_IDENTITY_PROVIDERS)[number];
export type SubjectIdentityProvider = Exclude<IdentityProvider, "email">;
export type IdentityStrategy = "transfer" | "preserve-audit";
export type PathValueType = "text" | "jsonb";

export interface Relation {
  readonly schema: string;
  readonly table: string;
}

export interface PatternDefaultMatcher {
  readonly kind: "pattern";
  readonly pattern: string;
}

export interface ExactDefaultMatcher {
  readonly kind: "exact";
  readonly value: unknown;
}

export type SignupDefaultMatcher = PatternDefaultMatcher | ExactDefaultMatcher;

export interface VerifiedEmailMatcher {
  readonly type: "verified-email";
  readonly providers: readonly IdentityProvider[];
  readonly emailEnvironmentVariable: string;
  readonly approvedEmailSha256: string;
}

export interface ProviderSubjectMatcher {
  readonly type: "provider-subject";
  readonly provider: SubjectIdentityProvider;
  readonly subjectEnvironmentVariable: string;
  readonly approvedSubjectSha256: string;
}

export type IdentityMatcher = VerifiedEmailMatcher | ProviderSubjectMatcher;

export interface IdentityReference extends Relation {
  readonly column: string;
  readonly required: boolean;
  readonly strategy: IdentityStrategy;
}

export interface JsonIdentityReference extends Relation {
  readonly column: string;
  readonly path: readonly string[];
}

export interface SignupDefaultDeclaration {
  readonly table: Relation;
  readonly identityColumn: string;
  readonly ignoredColumns: readonly string[];
  readonly values: Readonly<Record<string, SignupDefaultMatcher>>;
}

export interface PathIdentityReference extends Relation {
  readonly column: string;
  readonly valueType: PathValueType;
}

export interface IdentityAsset {
  readonly bucket: string;
  readonly prefix: string;
  readonly rewritePath: boolean;
}

export interface IdentityTokenHook {
  readonly function: Readonly<{ schema: string; name: string }>;
  readonly expectedClaims: JsonObject;
}

export interface IdentityDeclaration {
  readonly name: string;
  readonly matcher: IdentityMatcher;
  readonly placeholderUserId: string;
  readonly references: readonly IdentityReference[];
  readonly jsonReferences: readonly JsonIdentityReference[];
  readonly signupDefaults: readonly SignupDefaultDeclaration[];
  readonly pathReferences: readonly PathIdentityReference[];
  readonly assets: readonly IdentityAsset[];
  readonly claims: JsonObject;
  readonly tokenHook: IdentityTokenHook | null;
}

export interface IdentityPolicy {
  readonly identityVersion: 1;
  readonly identities: readonly IdentityDeclaration[];
}

export interface IdentityClaimReview {
  readonly planVersion: 3;
  readonly operation: "claim-local-identity";
  readonly name: string;
  readonly matcher: IdentityMatcher;
  readonly placeholderUserId: string;
  readonly references: readonly IdentityReference[];
  readonly jsonReferences: readonly JsonIdentityReference[];
  readonly signupDefaults: readonly Readonly<{
    table: Relation;
    identityColumn: string;
    ignoredColumns: readonly string[];
    valuesSha256: string;
  }>[];
  readonly pathReferences: readonly PathIdentityReference[];
  readonly assets: readonly IdentityAsset[];
  readonly claimKeys: readonly string[];
  readonly claimsSha256: string;
  readonly tokenHook: Readonly<{
    function: Readonly<{ schema: string; name: string }>;
    expectedClaimsSha256: string;
  }> | null;
}

export interface IdentityClaimPlan {
  readonly identity: IdentityDeclaration;
  readonly review: Readonly<IdentityClaimReview>;
  readonly digest: string;
}

export interface QueryResult<Row extends JsonObject = JsonObject> {
  readonly rows: Row[];
}

export interface IdentityDatabaseClient {
  connect?(): Promise<void>;
  end?(): Promise<void>;
  query<Row extends JsonObject = JsonObject>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export type IdentityClientFactory = (
  connectionString: string,
) => IdentityDatabaseClient | Promise<IdentityDatabaseClient>;

export interface StorageCopy {
  readonly bucket: string;
  readonly source: string;
  readonly destination: string;
}

export interface IdentityClaimResult {
  readonly name: string;
  readonly provider: IdentityProvider;
  readonly claimed: true;
  readonly removedSignupDefaults: number;
  readonly tokenHookVerified: boolean;
  readonly placeholderRetainedForAudit: boolean;
  readonly storageObjectsTransferred: number;
  readonly idempotent: boolean;
}
