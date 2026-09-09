import { describe, expect, test } from "@jest/globals";

import {
  DEFAULT_RULES,
  matchPath,
  matchRule,
  matchSchema,
  normalizeFieldName,
  parseFields,
  parseRules,
  resolveKind,
  validateRules,
} from "./rules";

const CONTENT_V1 = "iglu:org.understood/content/jsonschema/1-0-3";
const CONTENT_REFERENCE_V2 =
  "iglu:org.understood/content_reference/jsonschema/2-0-0";
const CONTENT_METADATA_V1 =
  "iglu:org.understood/content_metadata/jsonschema/1-0-1";

describe("matchSchema", () => {
  test("matches exact URIs", () => {
    expect(matchSchema(CONTENT_V1, CONTENT_V1)).toBe(true);
  });

  test("matches version wildcards", () => {
    const pattern = "iglu:org.understood/content/jsonschema/1-*";
    expect(matchSchema(pattern, CONTENT_V1)).toBe(true);
    expect(
      matchSchema(pattern, "iglu:org.understood/content/jsonschema/1-2-0"),
    ).toBe(true);
    expect(
      matchSchema(pattern, "iglu:org.understood/content/jsonschema/2-0-0"),
    ).toBe(false);
  });

  test("does not match other vendors or names", () => {
    const pattern = "iglu:org.understood/content/jsonschema/1-*";
    expect(
      matchSchema(pattern, "iglu:com.example/content/jsonschema/1-0-0"),
    ).toBe(false);
    expect(matchSchema(pattern, CONTENT_REFERENCE_V2)).toBe(false);
  });

  test("wildcard segments match anything", () => {
    expect(matchSchema("iglu:org.understood/*/jsonschema/*", CONTENT_V1)).toBe(
      true,
    );
  });
});

describe("matchPath", () => {
  test("matches exact paths", () => {
    expect(matchPath("content_id", "content_id")).toBe(true);
    expect(matchPath("content_id", "component_id")).toBe(false);
  });

  test("wildcards match any single segment", () => {
    expect(matchPath("data.*.id", "data.0.id")).toBe(true);
    expect(matchPath("data.*.id", "data.12.id")).toBe(true);
    expect(matchPath("data.*.id", "data.foo.id")).toBe(true);
  });

  test("requires the same depth", () => {
    expect(matchPath("data.*.id", "data.id")).toBe(false);
    expect(matchPath("data.*.id", "data.0.nested.id")).toBe(false);
    expect(matchPath("id", "data.0.id")).toBe(false);
  });
});

describe("DEFAULT_RULES", () => {
  test.each([
    "content_id",
    "component_id",
    "child_component_id",
    "parent_component_id",
    "linked_content_id",
  ])("matches %s in content 1-* as an entry", (path) => {
    const rule = matchRule(DEFAULT_RULES, CONTENT_V1, path);
    expect(rule).toBeDefined();
    expect(resolveKind(rule!, {})).toBe("entry");
  });

  test("matches content_type_id in content 1-* as a content type", () => {
    const rule = matchRule(DEFAULT_RULES, CONTENT_V1, "content_type_id");
    expect(rule).toBeDefined();
    expect(resolveKind(rule!, {})).toBe("content-type");
  });

  test("matches id in content_reference 2-* via type discriminator", () => {
    const data = { id: "3K9dOxAbCd", type: "entry" };
    const rule = matchRule(DEFAULT_RULES, CONTENT_REFERENCE_V2, "id");
    expect(rule).toBeDefined();
    expect(resolveKind(rule!, data)).toBe("entry");
    expect(resolveKind(rule!, { ...data, type: "asset" })).toBe("asset");
  });

  test("matches data.*.id in content_metadata 1-* via type discriminator", () => {
    const item = { id: "3K9dOxAbCd", type: "asset" };
    const rule = matchRule(DEFAULT_RULES, CONTENT_METADATA_V1, "data.3.id");
    expect(rule).toBeDefined();
    expect(resolveKind(rule!, item)).toBe("asset");
  });

  test("unknown discriminator values produce no kind", () => {
    const rule = matchRule(DEFAULT_RULES, CONTENT_REFERENCE_V2, "id");
    expect(resolveKind(rule!, { id: "x", type: "topic" })).toBeUndefined();
    expect(resolveKind(rule!, { id: "x" })).toBeUndefined();
    expect(resolveKind(rule!, undefined)).toBeUndefined();
  });

  test("does not match unrelated paths or schemas", () => {
    expect(
      matchRule(DEFAULT_RULES, CONTENT_V1, "content_type"),
    ).toBeUndefined();
    expect(
      matchRule(DEFAULT_RULES, CONTENT_REFERENCE_V2, "type"),
    ).toBeUndefined();
    expect(
      matchRule(
        DEFAULT_RULES,
        "iglu:com.snowplowanalytics.snowplow/web_page/jsonschema/1-0-0",
        "id",
      ),
    ).toBeUndefined();
  });
});

describe("validateRules / parseRules", () => {
  test("empty input means defaults", () => {
    expect(validateRules("")).toBeUndefined();
    expect(validateRules("  \n")).toBeUndefined();
    expect(parseRules("")).toBeNull();
  });

  test("round-trips the default rules", () => {
    const json = JSON.stringify(DEFAULT_RULES);
    expect(validateRules(json)).toBeUndefined();
    expect(parseRules(json)).toEqual(DEFAULT_RULES);
  });

  test("rejects invalid JSON", () => {
    expect(validateRules("{oops")).toMatch(/valid JSON/);
    expect(parseRules("{oops")).toBeNull();
  });

  test("rejects non-arrays", () => {
    expect(validateRules("{}")).toMatch(/array/);
  });

  test("rejects rules without schema, paths, or a kind", () => {
    expect(validateRules('[{"paths":["id"],"kind":"entry"}]')).toMatch(
      /Rule 1/,
    );
    expect(
      validateRules('[{"schema":"iglu:a/b/c/1-*","kind":"entry"}]'),
    ).toMatch(/Rule 1/);
    expect(
      validateRules('[{"schema":"iglu:a/b/c/1-*","paths":["id"]}]'),
    ).toMatch(/Rule 1/);
    expect(
      validateRules(
        '[{"schema":"iglu:a/b/c/1-*","paths":["id"],"kind":"nope"}]',
      ),
    ).toMatch(/Rule 1/);
  });

  test("accepts discriminator rules", () => {
    const json = JSON.stringify([
      {
        schema: "iglu:a/b/jsonschema/1-*",
        paths: ["id"],
        discriminator: { field: "type", map: { entry: "entry" } },
      },
    ]);
    expect(validateRules(json)).toBeUndefined();
    expect(parseRules(json)).toHaveLength(1);
  });
});

describe("parseFields", () => {
  test("splits, trims and drops blanks", () => {
    expect(parseFields(" slug , internalName ")).toEqual([
      "slug",
      "internalName",
    ]);
    expect(parseFields("slug,,internalName,")).toEqual([
      "slug",
      "internalName",
    ]);
  });

  test("preserves configured order and drops duplicates", () => {
    expect(parseFields("b, a, b")).toEqual(["b", "a"]);
  });

  test("treats empty input as unconfigured, so defaults apply", () => {
    expect(parseFields("")).toBeNull();
    expect(parseFields("   ")).toBeNull();
    expect(parseFields(" , - , ")).toBeNull();
  });

  test("keeps the first spelling of names that differ only in form", () => {
    expect(parseFields("Page key, pageKey, page_key")).toEqual(["Page key"]);
  });
});

describe("normalizeFieldName", () => {
  test("collapses labels, casing and punctuation to one form", () => {
    const forms = ["pageKey", "Page key", "page_key", "Page-Key", "PAGEKEY"];
    for (const form of forms) expect(normalizeFieldName(form)).toBe("pagekey");
  });

  test("keeps distinct names distinct", () => {
    expect(normalizeFieldName("siteSection")).not.toBe(
      normalizeFieldName("surveyKey"),
    );
  });
});
