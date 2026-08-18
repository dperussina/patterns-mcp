/**
 * The held-out task set, run.
 *
 * Everything else in this repository asks whether the generator is self-consistent: the code compiles, its
 * own tests pass, and the bytes match what they matched last time. A bundle can satisfy all three and
 * answer a question nobody asked, and no snapshot would notice, because a snapshot's expectation is
 * whatever was last produced. This is the only suite whose expectations come from outside the generator —
 * seventeen problems written in the words of the person who has them, each asserting that what came back is
 * reachable and does the thing.
 *
 * Configured the way SC-006 says a caller configures it: through `describe_pattern`, with the goal's own
 * stated needs applied on top. Selecting the pattern from the goal is the step no offline harness can
 * measure, so the answer key supplies it; everything after the choice is measured.
 */

import { describe, expect, it } from "vitest";

import { describePattern, generate } from "../../src/index.js";
import { DEFAULT_NOUN } from "./reader.js";
import { TASKS, isAdvisoryTask } from "./tasks.js";
import type { Task } from "./tasks.js";

/** Everything a caller would integrate, which is where a capability has to be reachable. */
function integrated(files: readonly { path: string; contents: string; role: string }[]): string {
  return files
    .filter((file) => file.role !== "test")
    .map((file) => file.contents)
    .join("\n");
}

async function attempt(task: Task): Promise<string> {
  const detail = await describePattern(task.pattern);

  const identifiers = Object.fromEntries(
    detail.identifiers.map((role) => [role.name, task.noun ?? DEFAULT_NOUN]),
  );

  const result = await generate({
    pattern: task.pattern,
    identifiers,
    ...(task.options === undefined ? {} : { options: task.options }),
  });

  if (result.kind === "advisory") {
    // Advice is an answer, and a caller acting on it needs both halves: what to do instead, and why this
    // was not it. A rationale that had emptied would still be a well-formed response.
    expect(result.alternative).not.toBe("");
    expect(result.rationale.length).toBeGreaterThan(40);
    return "";
  }

  return integrated(result.files);
}

describe.each(TASKS.map((task) => ({ task, name: task.pattern })))("$name", ({ task }) => {
  it(
    isAdvisoryTask(task)
      ? "answers with what to do instead, which is the answer"
      : "returns something that does what the goal asked for",
    async () => {
      const source = await attempt(task);

      const missing = task.needs.filter((need) => !need.test(source));
      expect(
        missing.map((need) => need.source),
        `${task.pattern} did not deliver what the goal asked for`,
      ).toEqual([]);
    },
    300_000,
  );
});

describe("the task set itself", () => {
  it("never tells the reader the answer", () => {
    // A goal that used the catalogue's vocabulary would make this suite confirm that the vocabulary exists.
    // The pattern's own name is the obvious leak and the one worth pinning, since the others are a matter
    // of how a goal is worded and this is a matter of whether it was worded at all.
    const leaks = TASKS.filter((task) => {
      const words = task.pattern.split("-");
      return words.every((word) => task.goal.toLowerCase().includes(word));
    });

    expect(leaks.map((task) => task.pattern)).toEqual([]);
  });

  it("reaches advice as well as code", () => {
    // Both kinds of valid answer. A task set made only of generative patterns would leave the seven
    // advisory entries untested through the surface a caller actually uses, and "nothing was generated,
    // and that is the answer" is the reply most likely to be mistaken for a failure.
    expect(TASKS.filter((task) => isAdvisoryTask(task)).length).toBeGreaterThan(1);
    expect(TASKS.filter((task) => !isAdvisoryTask(task)).length).toBeGreaterThan(10);
  });
});
