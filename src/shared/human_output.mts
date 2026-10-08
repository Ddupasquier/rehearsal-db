/** Purpose: Keep human-facing Rehearsal counts grammatically consistent. */

export const formatCount = (
  count: number,
  singular: string,
  plural: string = `${singular}s`,
): string => `${count} ${count === 1 ? singular : plural}`;
