/** Keep the stable user environment separate from ephemeral Core SQL callbacks. */
export const configureKnexApplication = async <
  Environment extends object,
  Result,
>({
  captureEnvironment,
  freezeEnvironment = true,
  withQueryPhase,
  configure,
  publish,
}: {
  captureEnvironment: () => Environment;
  freezeEnvironment?: boolean;
  withQueryPhase: (work: () => Result | Promise<Result>) => Promise<Result>;
  configure: (environment: Readonly<Environment>) => Result | Promise<Result>;
  publish: (
    environment: Readonly<Environment>,
    result: Result,
  ) => Promise<void>;
}): Promise<Readonly<Environment>> => {
  // Capture while the persistent application phase is current. Neither the
  // callback nor its temporary query role may replace these user credentials.
  const captured = captureEnvironment();
  const environment = freezeEnvironment
    ? Object.freeze({ ...captured })
    : captured;
  const result = await withQueryPhase(() => configure(environment));
  await publish(environment, result);
  return environment;
};
