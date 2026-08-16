/**
 * The runtime this engine needs, in the one place three things can read it.
 *
 * Executing a generated test sandboxes it under Node's permission model (`run-tests.ts`), and the flag
 * that enables it was called `--experimental-permission` until Node 22.13.0 renamed it. An older
 * runtime does not reject the sandbox — it rejects the *flag*, before the test file is even read, and
 * the child exits with `bad option`. That surfaced as "Generated code failed its tests. This is a
 * defect in the pattern": we blamed our own catalogue for the operator's Node version, and told the
 * caller to report it.
 *
 * So the floor is stated once and read by the `engines` field, the server's startup check, and the
 * engine itself. Held to that by a test, because a constant here and a range in `package.json` are
 * exactly the pair that drifts.
 */

/**
 * The first version accepting `--permission` under that name.
 *
 * Not lowered by passing the older flag name on an older runtime. Node 20 left support in April 2026,
 * so the branch would exist to serve a runtime nobody should be running, and it would be the branch
 * least likely to be exercised — a sandbox that silently stopped sandboxing is the failure this whole
 * mechanism exists to prevent.
 */
export const MINIMUM_NODE = "22.13.0";

/** Whether generated tests can be executed under this runtime. */
export function runtimeSupported(version: string = process.versions.node): boolean {
  return compare(version, MINIMUM_NODE) >= 0;
}

/**
 * Orders two versions by their numeric components.
 *
 * A prerelease suffix is dropped rather than ordered, which treats `23.0.0-nightly` as `23.0.0`. That
 * is the right answer for the question being asked — whether a flag exists — and semver's rule that a
 * prerelease sorts *below* its release would give the wrong one for a nightly built well after the
 * feature landed.
 */
function compare(left: string, right: string): number {
  const a = components(left);
  const b = components(right);

  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const one = a[index] ?? 0;
    const other = b[index] ?? 0;
    // An unparseable component is treated as older, so a version string we do not understand fails
    // closed onto the refusal rather than through it.
    if (Number.isNaN(one)) return -1;
    if (Number.isNaN(other)) return 1;
    if (one !== other) return one < other ? -1 : 1;
  }

  return 0;
}

function components(version: string): number[] {
  return version
    .split("-")[0]!
    .split(".")
    .map((part) => Number.parseInt(part, 10));
}
