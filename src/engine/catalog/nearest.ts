/**
 * Suggesting what the caller probably meant.
 *
 * The point of a suggestion is that a typo costs one retry rather than a discovery round trip
 * (SC-007), and the typo that matters most is the ordinary kind: a dropped, doubled, or swapped
 * character. Substring matching alone misses every one of those — `reslt` neither contains nor is
 * contained by `result` — so this measures edit distance and keeps containment as well, which catches
 * the other common case of a caller naming a family rather than an entry.
 *
 * Lives beside the catalog because `describePattern` owes callers the same suggestion for the same
 * mistake, and two implementations would eventually disagree about what is near.
 */

/** Distance beyond which a suggestion is noise rather than help. */
const MAX_DISTANCE = 2;

export interface Suggestable {
  readonly name: string;
}

/**
 * The closest names to `requested`, best first, capped at `limit`.
 *
 * Ordering is by distance and then by name, so it is total: two candidates equally close always come
 * back in the same order, and the message for a given mistake does not vary between runs.
 */
export function nearestNames(
  candidates: readonly Suggestable[],
  requested: string,
  limit = 5,
): readonly string[] {
  const target = requested.toLowerCase();

  return candidates
    .map((candidate) => {
      const name = candidate.name.toLowerCase();
      const contained = name.includes(target) || target.includes(name);
      return {
        name: candidate.name,
        // Containment is treated as very near without being free, so an exact-ish typo still wins.
        distance: contained ? Math.min(1, editDistance(name, target)) : editDistance(name, target),
      };
    })
    .filter((scored) => scored.distance <= MAX_DISTANCE)
    .toSorted((a, b) => a.distance - b.distance || compare(a.name, b.name))
    .slice(0, limit)
    .map((scored) => scored.name);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Levenshtein distance over two rows rather than a full matrix.
 *
 * Counts insertions, deletions, and substitutions. A transposition costs two here rather than one,
 * which is why `MAX_DISTANCE` is 2 and not 1: swapping two characters is a typo a caller makes.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i, ...Array.from({ length: b.length }, () => 0)];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    previous = current;
  }

  return previous[b.length] ?? 0;
}
