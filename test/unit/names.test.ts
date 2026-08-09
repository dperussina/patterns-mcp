import { describe, expect, it } from "vitest";

import {
  deriveNames,
  loadNameTable,
  splitWords,
  type NameTable,
} from "../../src/engine/options/names.js";

const table: NameTable = await loadNameTable();

function names(singular: string): ReturnType<typeof deriveNames> {
  return deriveNames(singular, table);
}

function derived(
  singular: string,
): NonNullable<Extract<ReturnType<typeof deriveNames>, { ok: true }>["names"]> {
  const result = names(singular);
  if (!result.ok) {
    throw new Error(
      `expected "${singular}" to resolve, got: ${result.problem}`,
    );
  }
  return result.names;
}

function refusal(singular: string): string {
  const result = names(singular);
  if (result.ok) {
    throw new Error(`expected "${singular}" to be refused`);
  }
  return result.problem;
}

describe("splitWords", () => {
  it.each([
    ["Person", ["Person"]],
    ["orderItem", ["order", "Item"]],
    ["order_item", ["order", "item"]],
    ["OrderItemLine", ["Order", "Item", "Line"]],
    ["Order2Item", ["Order2", "Item"]],
  ])("splits %s", (input, expected) => {
    expect(splitWords(input)).toEqual(expected);
  });

  it("keeps an acronym whole, so the stem is http-server not h-t-t-p-server", () => {
    expect(splitWords("HTTPServer")).toEqual(["HTTP", "Server"]);
    expect(derived("HTTPServer").kebab).toBe("http-server");
  });
});

describe("deriveNames casing", () => {
  it("derives every form from a Pascal-case name", () => {
    expect(derived("OrderItem")).toMatchObject({
      singular: "OrderItem",
      plural: "OrderItems",
      camel: "orderItem",
      pascal: "OrderItem",
      kebab: "order-item",
      screamingSnake: "ORDER_ITEM",
      stem: "order-item",
      pluralStem: "order-items",
      pluralEqualsSingular: false,
    });
  });

  it("answers in the style the caller asked in", () => {
    expect(derived("orderItem").plural).toBe("orderItems");
    expect(derived("order_item").plural).toBe("order_items");
    expect(derived("ORDER_ITEM").plural).toBe("ORDER_ITEMS");
    expect(derived("OrderItem").plural).toBe("OrderItems");
  });

  it("preserves an acronym rather than title-casing it", () => {
    expect(derived("HTTPServer").pascal).toBe("HTTPServer");
    expect(derived("HTTPServer").camel).toBe("httpServer");
  });
});

describe("deriveNames pluralisation", () => {
  it.each([
    ["Person", "People"],
    ["Child", "Children"],
    ["Matrix", "Matrices"],
    ["Status", "Statuses"],
    ["Analysis", "Analyses"],
    ["Leaf", "Leaves"],
    ["Photo", "Photos"],
  ])("uses the exception table for %s", (singular, plural) => {
    expect(derived(singular).plural).toBe(plural);
  });

  it.each([
    ["Order", "Orders"],
    ["Address", "Addresses"],
    ["Box", "Boxes"],
    ["Branch", "Branches"],
    ["Dish", "Dishes"],
    ["Category", "Categories"],
    ["Video", "Videos"],
    ["Day", "Days"],
  ])("applies the default rule to %s", (singular, plural) => {
    expect(derived(singular).plural).toBe(plural);
  });

  it("pluralises only the final word of a compound", () => {
    expect(derived("OrderPerson").plural).toBe("OrderPeople");
    expect(derived("PersonOrder").plural).toBe("PersonOrders");
  });

  it("reports when a plural equals its singular, rather than emitting one name twice", () => {
    const series = derived("Series");
    expect(series.plural).toBe("Series");
    expect(series.pluralEqualsSingular).toBe(true);
    expect(derived("Order").pluralEqualsSingular).toBe(false);
  });
});

describe("deriveNames refusals", () => {
  it.each([
    // Each of these is absent from the exception table; words that are present,
    // like Leaf, resolve instead.
    ["Reef", "-f or -fe"],
    ["Cargo", "a consonant followed by -o"],
    ["Genesis", "a Latin or Greek ending"],
  ])("refuses %s rather than guessing", (singular, why) => {
    const problem = refusal(singular);
    expect(problem).toContain("cannot derive a plural");
    expect(problem).toContain(why);
  });

  it("states the rule and that the word is absent from the table", () => {
    expect(refusal("Cargo")).toContain("not in it");
  });

  it("checks ambiguity before the confident rules, so -us is not swallowed by -s", () => {
    // "Abacus" ends in -s, which the default rule would happily turn into
    // "Abacuses"; the Latin ending has to win.
    expect(refusal("Abacus")).toContain("Latin or Greek");
  });

  it("refuses an invalid identifier before attempting derivation", () => {
    expect(refusal("class")).toContain("is reserved");
    expect(refusal("2fast")).toContain("not a valid identifier");
  });

  it("passes the caller's emitted-identifier list through to validation", () => {
    const result = deriveNames("PersonStore", table, {
      reserved: ["PersonStore"],
    });
    expect(result.ok).toBe(false);
  });
});

describe("name table", () => {
  it("stores exception keys in lowercase, which the deriver relies on", () => {
    for (const key of Object.keys(table.irregular)) {
      expect(key).toBe(key.toLowerCase());
    }
    for (const word of table.invariant.words) {
      expect(word).toBe(word.toLowerCase());
    }
  });

  it("holds no entry the default rule would already get right", () => {
    // An entry that agrees with the default rule is dead weight that still has
    // to be reviewed on every change.
    const redundant = Object.entries(table.irregular).filter(
      ([singular, plural]) => {
        if (/(?:[^aeiou]o|fe|f|us|is|on|um|ex|ix)$/.test(singular)) {
          return false;
        }
        const byDefault = /(?:s|x|z|ch|sh)$/.test(singular)
          ? `${singular}es`
          : /[^aeiou]y$/.test(singular)
            ? `${singular.slice(0, -1)}ies`
            : `${singular}s`;
        return byDefault === plural;
      },
    );

    expect(redundant).toEqual([]);
  });
});
