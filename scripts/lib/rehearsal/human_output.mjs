/** Purpose: Keep human-facing Rehearsal counts grammatically consistent. */

export const formatCount = (count, singular, plural = `${singular}s`) =>
  `${count} ${count === 1 ? singular : plural}`;
