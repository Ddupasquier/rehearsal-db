/** Reviewed opt-in sampling declarations and privacy-safe fidelity evidence. */

export interface ShapeTable {
  readonly schema: string;
  readonly name: string;
  readonly key: readonly string[];
  readonly maximumRows: number;
  readonly rootRows: number;
  readonly requiredKeySha256: readonly string[];
}

export interface ShapeEndpoint {
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly string[];
}

export interface ShapeRelationship {
  readonly id: string;
  readonly parent: ShapeEndpoint;
  readonly child: ShapeEndpoint;
  readonly nullable: boolean;
  readonly includeChildren: boolean;
  readonly maximumChildrenPerParent: number;
  readonly maximumRows: number;
}

export type ShapeDistributionKind =
  | "null"
  | "boolean"
  | "number"
  | "timestamp"
  | "string-length"
  | "array-length"
  | "enum"
  | "empty"
  | "relationship-fanout"
  | "number-extrema"
  | "timestamp-extrema"
  | "string-length-extrema"
  | "array-length-extrema";

export interface ShapeDistribution {
  readonly id: string;
  readonly schema: string;
  readonly table: string;
  readonly column: string | null;
  readonly kind: ShapeDistributionKind;
  readonly boundaries: readonly number[];
  readonly required: boolean;
  readonly tolerance: number;
  readonly minimumBucketRows: number;
  readonly requiredBuckets: readonly string[];
  readonly values: readonly (string | number | boolean)[];
  readonly includeOther: boolean;
  readonly relationship: string | null;
}

export interface ShapeJointDistribution {
  readonly id: string;
  readonly schema: string;
  readonly table: string;
  readonly goals: readonly string[];
  readonly bucketCount: number;
  readonly required: boolean;
  readonly tolerance: number;
  readonly minimumBucketRows: number;
  readonly requiredBuckets: readonly string[];
}

export type ShapeGoal = ShapeDistribution | ShapeJointDistribution;

export interface BaselineShapePolicy {
  readonly shapeVersion: 1;
  readonly seed: string;
  readonly maximumSourceRows: number;
  readonly maximumSourceBytes: number;
  readonly maximumRows: number;
  readonly maximumDepth: number;
  readonly minimumCohortSize: number;
  readonly tables: readonly ShapeTable[];
  readonly relationships: readonly ShapeRelationship[];
  readonly distributions: readonly ShapeDistribution[];
  readonly jointDistributions: readonly ShapeJointDistribution[];
}

export interface ShapeBucketEvidence {
  /** Bucket index only. Reviewed boundaries remain in the project policy. */
  readonly bucket: string;
  readonly sourceCount: number | null;
  readonly selectedSourceCount: number | null;
  readonly baselineCount: number | null;
  readonly disposition:
    | "represented"
    | "transformed"
    | "omitted"
    | "absent"
    | "introduced"
    | "suppressed";
  readonly difference: number | null;
  readonly suppressed: boolean;
  readonly reason:
    | "within-tolerance"
    | "outside-tolerance"
    | "missing-required-source-class"
    | "insufficient-selected-class"
    | "insufficient-sanitized-class"
    | "privacy-cohort";
  readonly status: "passed" | "failed" | "suppressed";
}

export interface BaselineShapeEvidence {
  readonly shapeVersion: 1;
  readonly algorithm: "bounded-keyed-graph-v1";
  readonly rehearsalVersion: string;
  readonly generationId: string;
  readonly baselineDataSha256: string;
  readonly policySha256: string;
  readonly privacyPolicySha256: string;
  readonly sourceSchemaSha256: string;
  readonly sourceSnapshotSha256: string;
  readonly seedSha256: string;
  readonly maximumRows: number;
  readonly maximumSourceRows: number;
  readonly maximumSourceBytes: number;
  readonly maximumDepth: number;
  readonly minimumCohortSize: number;
  readonly tables: readonly {
    readonly schema: string;
    readonly table: string;
    readonly sourceRows: number;
    readonly selectedRows: number;
    readonly emittedRows: number;
  }[];
  readonly relationships: readonly {
    readonly id: string;
    readonly checkedRows: number;
    readonly status: "passed";
  }[];
  readonly distributions: readonly {
    readonly id: string;
    readonly required: boolean;
    readonly tolerance: number;
    readonly status: "passed" | "failed" | "suppressed";
    readonly buckets: readonly ShapeBucketEvidence[];
  }[];
  readonly warnings: readonly string[];
  readonly limitations: readonly string[];
  readonly evidenceSha256: string;
}

export interface ShapeRecord {
  readonly schema?: string;
  readonly table: string;
  readonly row: Readonly<Record<string, unknown>>;
}

export const shapeTableIdentity = (schema: string, table: string): string =>
  `${schema}.${table}`;
