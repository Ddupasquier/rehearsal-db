/** Synthetic observations shared by the demo's HTTP proof and physical DB checks. */
export const demoObservationSql = `
select json_build_object(
  'publicRows', (select count(*) from public.widgets),
  'nullDescriptions', (select count(*) from public.widgets where description is null),
  'reviewedDescriptions', (select count(*) from public.widgets where description = 'Reviewed synthetic description'),
  'descriptionRequired', (select is_nullable = 'NO' from information_schema.columns where table_schema = 'public' and table_name = 'widgets' and column_name = 'description'),
  'publicationRows', (select count(*) from blendcalc_api.widgets),
  'fixtureRowsPreserved', (
    not exists(select 1 from public.widgets where id <> 1 or name <> 'Synthetic Widget' or created_at <> timestamptz '2026-01-01T00:00:00Z')
    and not exists(select 1 from blendcalc_api.widgets where id <> 7 or name <> 'Synthetic Publication Widget' or created_at <> timestamptz '2026-01-02T00:00:00Z')
  )
);
`;

export const assertDemoObservation = (
  observation,
  { expectedRows, descriptionRequired },
) => {
  if (
    ![0, 1].includes(expectedRows) ||
    typeof descriptionRequired !== "boolean"
  ) {
    throw new Error("Invalid synthetic PostgreSQL demo expectations.");
  }
  if (
    !observation ||
    observation.publicRows !== expectedRows ||
    observation.nullDescriptions !== (descriptionRequired ? 0 : expectedRows) ||
    observation.reviewedDescriptions !==
      (descriptionRequired ? expectedRows : 0) ||
    observation.descriptionRequired !== descriptionRequired ||
    observation.publicationRows !== 1 ||
    observation.fixtureRowsPreserved !== true
  ) {
    throw new Error(
      "The synthetic PostgreSQL demo observation did not match its reviewed phase.",
    );
  }
  return observation;
};
