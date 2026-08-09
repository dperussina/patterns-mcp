import { describe, expect, it } from "vitest";

import { version } from "../../src/index.js";

describe("patterns", () => {
  it("exposes a version", () => {
    expect(version).toBeTypeOf("string");
  });
});
