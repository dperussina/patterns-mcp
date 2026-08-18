import { describe, expect, it } from "vitest";

import {
  deriveNames,
  loadNameTable,
  splitWords,
  withNoun,
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

  it.each([
    ["user__name", ["user", "name"]],
    ["_user", ["user"]],
    ["user$id", ["user", "id"]],
  ])(
    "drops the empty run separators leave, so %s yields no blank word",
    (input, expected) => {
      expect(splitWords(input)).toEqual(expected);
    },
  );

  it("discards a leading underscore rather than carrying it into every form", () => {
    // A caller writing _user gets user back. The underscore is a visibility
    // convention on one declaration, not part of the name being derived, and
    // carrying it through would produce file names like _user.ts.
    expect(derived("_user")).toMatchObject({
      camel: "user",
      pascal: "User",
      kebab: "user",
      plural: "users",
    });
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

  it.each([
    ["ID", "IDs"],
    ["URL", "URLs"],
    ["API", "APIs"],
    ["UUID", "UUIDs"],
    ["userID", "userIDs"],
    ["ResourceURL", "ResourceURLs"],
  ])("keeps the acronym intact when pluralising %s", (singular, plural) => {
    expect(derived(singular).plural).toBe(plural);
  });

  it("upper-cases a table plural for a shouted word, which is not an acronym", () => {
    // CHILD is a word in caps, so the whole table entry follows the source's
    // case. ID is an acronym, so only the suffix is lowered. The two rules
    // disagree by design; neither reading applies to both inputs.
    expect(derived("CHILD").plural).toBe("CHILDREN");
    expect(derived("ID").plural).toBe("IDs");
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

  it.each([
    // Verb-derived `-ion` nouns: the commonest shape an English domain noun takes, and every one of
    // them takes `-s`. The `-on` rule used to claim all of these were doubtful, which refused a
    // seventh of a realistic noun list — including the three commonest entities most services have.
    ["Subscription", "Subscriptions"],
    ["Transaction", "Transactions"],
    ["Session", "Sessions"],
    ["Permission", "Permissions"],
    ["Region", "Regions"],
  ])("pluralises %s confidently, since -ion is not the doubtful ending", (singular, plural) => {
    expect(derived(singular).plural).toBe(plural);
  });

  it.each([
    // What the `-on` rule was aimed at. Each resolves through the exception table, which is
    // consulted before the ambiguity check — so narrowing the rule cost none of them.
    ["Criterion", "Criteria"],
    ["Phenomenon", "Phenomena"],
  ])("still gives %s its Greek plural, from the table", (singular, plural) => {
    expect(derived(singular).plural).toBe(plural);
  });

  it("still doubts a bare -on absent from the table", () => {
    // `automata` against `automatons`, and the word is not in the table — which is the doubt the
    // rule was written for, left intact by narrowing `-ion` out of it.
    expect(refusal("Automaton")).toContain("Latin or Greek");
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

describe("withNoun", () => {
  it("appends the pattern's noun, in every form", () => {
    expect(withNoun(derived("Order"), "Id")).toEqual({
      pascal: "OrderId",
      kebab: "order-id",
      camel: "orderId",
    });
  });

  it("does not append a noun the name already ends with", () => {
    // The case this exists for: `branded-type` emits `${entity}Id`, and a branded
    // OrderId is the likeliest thing anyone asks it for. It answered OrderIdId,
    // in a file called order-id-id.ts.
    expect(withNoun(derived("OrderId"), "Id")).toEqual({
      pascal: "OrderId",
      kebab: "order-id",
      camel: "orderId",
    });
  });

  it("collapses an acronym written in caps, which is the same name", () => {
    expect(withNoun(derived("OrderID"), "Id").pascal).toBe("OrderID");
  });

  it("compares whole words, so a name merely ending in those letters still takes the noun", () => {
    // Paid and Grid end in the letters of Id without ending in the word, and a
    // suffix comparison on the lowercased forms would swallow both.
    expect(withNoun(derived("Paid"), "Id").pascal).toBe("PaidId");
    expect(withNoun(derived("Grid"), "Id").pascal).toBe("GridId");
  });

  it("kebabs a multi-word noun rather than gluing it on", () => {
    expect(withNoun(derived("Order"), "CircuitBreaker")).toEqual({
      pascal: "OrderCircuitBreaker",
      kebab: "order-circuit-breaker",
      camel: "orderCircuitBreaker",
    });
  });

  it("collapses a multi-word noun as a unit", () => {
    expect(withNoun(derived("OrderCircuitBreaker"), "CircuitBreaker")).toEqual({
      pascal: "OrderCircuitBreaker",
      kebab: "order-circuit-breaker",
      camel: "orderCircuitBreaker",
    });
  });

  it("answers in the caller's style, not the style they happened to ask in", () => {
    // The forms come from the derivation, so a camel-case request still yields a
    // Pascal type name and a kebab file stem.
    expect(withNoun(derived("orderId"), "Id")).toEqual({
      pascal: "OrderId",
      kebab: "order-id",
      camel: "orderId",
    });
  });

  it("leaves a name that is only the noun alone", () => {
    expect(withNoun(derived("Id"), "Id").pascal).toBe("Id");
  });

  /**
   * The overlap is removed wherever the names meet, not only when the noun is the whole of it.
   *
   * `typed-emitter` emits `${entity}EventName` and `${entity}Events`, and `Event` is the likeliest
   * subject anyone gives an emitter, so the caller who would have received `OrderIdId` received
   * `EventEventName` and `EventEvents` instead — both compiling, both exported, neither noticed by a
   * golden suite that names everything `Order`.
   */
  it("drops a partial overlap, keeping the words the noun adds", () => {
    expect(withNoun(derived("Event"), "EventName")).toEqual({
      pascal: "EventName",
      kebab: "event-name",
      camel: "eventName",
    });
  });

  it("treats the noun's plural as the same word, and keeps the plural", () => {
    // The one case where the noun's spelling survives instead of the entity's: `Events` is what the
    // call site asked for, and `EventEvents` names the same thing twice.
    expect(withNoun(derived("Event"), "Events")).toEqual({
      pascal: "Events",
      kebab: "events",
      camel: "events",
    });
  });

  it("appends a plural noun that is not the entity's own", () => {
    expect(withNoun(derived("Order"), "Events").pascal).toBe("OrderEvents");
  });

  /**
   * A secondary noun overlapping the entity partway along collapses at the seam like any other.
   *
   * Patterns derive several nouns from one entity, and `circuit-breaker`'s are `CircuitBreaker`,
   * `BreakerPolicy`, `BreakerOptions` and `BreakerOpenError` — so a caller naming their subject after
   * the artefact meets the seam three more times after the collapse that gives them their breaker. The
   * result is the name someone would write by hand, because the overlap is where the two names touch and
   * there is nothing to choose between.
   */
  it("collapses a secondary noun at the seam, not only the artefact's own", () => {
    const entity = derived("OrderCircuitBreaker");

    expect(withNoun(entity, "CircuitBreaker").pascal).toBe("OrderCircuitBreaker");
    expect(withNoun(entity, "BreakerPolicy").pascal).toBe("OrderCircuitBreakerPolicy");
    expect(withNoun(entity, "BreakerOptions").pascal).toBe("OrderCircuitBreakerOptions");
    expect(withNoun(entity, "BreakerOpenError").pascal).toBe("OrderCircuitBreakerOpenError");
  });

  /**
   * A word repeated away from the seam is kept, which is a decision rather than a gap.
   *
   * `Breaker` and `CircuitBreaker` share a word, and it is not where the names meet, so collapsing it
   * would mean deleting a word from the middle of one of them. Every candidate loses something the
   * caller has to have: eliding the noun's leading words gives `Breaker`, which is not the artefact;
   * eliding the entity gives `CircuitBreaker`, and with it the caller's subject — so two requests
   * naming different subjects would derive the same names and the same file stems, which is worse than
   * a long name by the distance between untidy and wrong. Only a synonym table could tell that
   * `Breaker` was meant as the whole artefact, and that is the coin flip this module refuses to make
   * elsewhere.
   *
   * Not refused either, though a refusal is what the seam collapse's absence might suggest. These are
   * ordinary domain nouns — the name is only awkward beside the one pattern that appends it, and
   * `Breaker` is perfectly good for the other twenty-five — so the refusal would have to be per-pattern
   * and could not say what to pass instead. It spends a turn to hand back nothing.
   */
  it("keeps a word repeated away from the seam, rather than guessing which to drop", () => {
    expect(withNoun(derived("Breaker"), "CircuitBreaker").pascal).toBe("BreakerCircuitBreaker");
    expect(withNoun(derived("Policy"), "BreakerPolicy").pascal).toBe("PolicyBreakerPolicy");
  });

  it("derives the value form from the words, not from the first character", () => {
    // `APIKeyId` lowercased at the first character is `aPIKeyId`, which is what two patterns emitted
    // — one of them as the name of an exported factory.
    expect(withNoun(derived("APIKey"), "Id").camel).toBe("apiKeyId");
    expect(withNoun(derived("HTTPRequest"), "Id").camel).toBe("httpRequestId");
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

  it("holds no entry the rules would already get right", () => {
    // An entry that agrees with what the deriver would have answered anyway is dead weight that still
    // has to be reviewed on every change.
    //
    // Asked by removing the entry and deriving again, rather than by restating the rules here. The
    // restatement drifted: it listed the ambiguous endings by hand, so when a bare `-s` became
    // doubtful — which is what makes entries like `lens` load-bearing rather than redundant — this
    // read as six words of dead weight.
    const redundant = Object.entries(table.irregular).filter(([singular, plural]) => {
      const without = {
        ...table,
        irregular: Object.fromEntries(
          Object.entries(table.irregular).filter(([key]) => key !== singular),
        ),
      };
      const derivation = deriveNames(singular, without);
      return derivation.ok && derivation.names.plural === plural;
    });

    expect(redundant).toEqual([]);
  });

  it("lists no word in both tables, where the irregular plural would win", () => {
    const both = table.invariant.words.filter(
      (word) => table.irregular[word] !== undefined,
    );

    expect(both).toEqual([]);
  });
});

describe("invariant nouns", () => {
  it.each(["Aircraft", "Corps", "Middleware", "Analytics", "Headquarters"])(
    "leaves %s alone rather than inventing a plural for it",
    (word) => {
      // Each of these was pluralised confidently and wrongly before the audit —
      // Aircrafts, Corpses, Middlewares, Analyticses, Headquarterses. They are
      // named here because a table entry is easy to drop by accident and the
      // sweep below would still pass with an empty list.
      expect(derived(word).plural).toBe(word);
    },
  );

  it("reports every listed word as invariant, in every casing style", () => {
    for (const word of table.invariant.words) {
      const lower = derived(word);
      expect(lower.plural, word).toBe(word);
      expect(lower.pluralEqualsSingular, word).toBe(true);

      const pascal = word[0]!.toUpperCase() + word.slice(1);
      expect(derived(pascal).plural, pascal).toBe(pascal);
    }
  });

  it("covers the endings a caller is most likely to reach for", () => {
    // The list cannot be complete, so this asserts the reasoning behind it
    // rather than its length: a domain noun ending in -ware or -craft is a mass
    // noun, and one of those groups is what this repository's own patterns are
    // named after.
    for (const word of ["firmware", "hardware", "middleware", "software"]) {
      expect(table.invariant.words, word).toContain(word);
    }
    for (const word of ["aircraft", "spacecraft", "watercraft"]) {
      expect(table.invariant.words, word).toContain(word);
    }
  });
});

describe("deriveNames and -ics", () => {
  it("doubts a name ending in -ics that the table does not settle", () => {
    // Topics is the plural of Topic, so a caller sending it as a singular has
    // made a mistake worth naming. The previous answer was Topicses.
    expect(refusal("Topics")).toContain("-ics");
    expect(refusal("Metrics")).toContain("field name");
  });

  it.each(["Analytics", "Logistics", "Diagnostics", "Statistics"])(
    "settles %s from the table, since the field name is invariant",
    (word) => {
      expect(derived(word).plural).toBe(word);
    },
  );
});

describe("deriveNames and a name that already ends in -s", () => {
  /**
   * A bare `-s` cannot be told apart from a plural, and pluralising one that is already plural is the
   * `Corpses` mistake in a different place. `Orders` is what a caller reaches for when they want an
   * order repository, and it produced `orderses` — the collection name, so it would have landed in a
   * schema rather than only in a type name.
   */
  it.each(["Orders", "Items", "Payments", "CustomerOrders"])("doubts %s", (word) => {
    expect(refusal(word)).toContain("as likely to be a plural already");
  });

  it.each([
    ["Class", "Classes"],
    ["Address", "Addresses"],
    ["Process", "Processes"],
    ["Business", "Businesses"],
  ])("keeps -ss confident: %s", (word, plural) => {
    // Nothing is in doubt about a double s, and refusing these would cost far more than the doubt
    // above buys.
    expect(derived(word).plural).toBe(plural);
  });

  it.each([
    ["Lens", "Lenses"],
    ["Alias", "Aliases"],
    ["Canvas", "Canvases"],
    ["Gas", "Gases"],
    ["Bias", "Biases"],
    ["Atlas", "Atlases"],
  ])("settles the singular %s from the table", (word, plural) => {
    // The escape hatch the doubt relies on: a genuine singular ending in a bare -s is listed, so the
    // rule costs a caller nothing for the words that have one right answer.
    expect(derived(word).plural).toBe(plural);
  });

  it("still explains -us and -is as the Latin ending they are", () => {
    // Listed before the bare -s rule on purpose: "statuses against radii" is the useful explanation
    // for these, and "a plural already" is not.
    expect(refusal("Apparatus")).toContain("Latin or Greek");
  });
});

describe("deriveNames and a final z", () => {
  it("doubles a single z after a vowel", () => {
    // The -s/-x/-z/-ch/-sh rule appended a bare -es and answered Quizes.
    expect(derived("Quiz").plural).toBe("Quizzes");
  });

  it.each([
    ["Waltz", "Waltzes"],
    ["Buzz", "Buzzes"],
  ])("leaves %s alone, where the z is not single and after a vowel", (word, plural) => {
    expect(derived(word).plural).toBe(plural);
  });
});
