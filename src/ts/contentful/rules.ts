import type { ContentKind, DetectionRule } from "./types";

const ENTRY_ASSET_DISCRIMINATOR = {
  field: "type",
  map: { entry: "entry", asset: "asset" } as Record<string, ContentKind>,
};

export const DEFAULT_RULES: DetectionRule[] = [
  {
    schema: "iglu:org.understood/content/jsonschema/1-*",
    paths: [
      "content_id",
      "component_id",
      "child_component_id",
      "parent_component_id",
      "linked_content_id",
    ],
    kind: "entry",
  },
  {
    schema: "iglu:org.understood/content/jsonschema/1-*",
    paths: ["content_type_id"],
    kind: "content-type",
  },
  {
    schema: "iglu:org.understood/content_reference/jsonschema/2-*",
    paths: ["id"],
    discriminator: ENTRY_ASSET_DISCRIMINATOR,
  },
  {
    schema: "iglu:org.understood/content_metadata/jsonschema/1-*",
    paths: ["data.*.id"],
    discriminator: ENTRY_ASSET_DISCRIMINATOR,
  },
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const segmentMatch = (pattern: string, value: string): boolean => {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === value;
  return new RegExp(
    "^" + pattern.split("*").map(escapeRegExp).join(".*") + "$",
  ).test(value);
};

export const matchSchema = (pattern: string, schema: string): boolean => {
  const p = pattern.replace(/^iglu:/i, "").split("/");
  const s = schema.replace(/^iglu:/i, "").split("/");
  return p.length === s.length && p.every((seg, i) => segmentMatch(seg, s[i]));
};

export const matchPath = (pattern: string, path: string): boolean => {
  const p = pattern.split(".");
  const s = path.split(".");
  return p.length === s.length && p.every((seg, i) => segmentMatch(seg, s[i]));
};

export const matchRule = (
  rules: DetectionRule[],
  schema: string,
  path: string,
): DetectionRule | undefined =>
  rules.find(
    (rule) =>
      matchSchema(rule.schema, schema) &&
      rule.paths.some((p) => matchPath(p, path)),
  );

export const resolveKind = (
  rule: DetectionRule,
  parent: unknown,
): ContentKind | undefined => {
  if (rule.kind) return rule.kind;
  if (rule.discriminator && typeof parent === "object" && parent !== null) {
    const value = (parent as Record<string, unknown>)[rule.discriminator.field];
    if (typeof value === "string") return rule.discriminator.map[value];
  }
  return undefined;
};

const KINDS: ContentKind[] = ["entry", "asset", "content-type"];

const isDetectionRule = (rule: unknown): rule is DetectionRule => {
  if (typeof rule !== "object" || rule === null) return false;
  const r = rule as Record<string, unknown>;
  if (typeof r.schema !== "string" || !r.schema) return false;
  if (
    !Array.isArray(r.paths) ||
    !r.paths.length ||
    !r.paths.every((p) => typeof p === "string" && p)
  )
    return false;
  if (r.kind !== undefined && !KINDS.includes(r.kind as ContentKind))
    return false;
  if (r.discriminator !== undefined) {
    const d = r.discriminator as Record<string, unknown>;
    if (typeof d !== "object" || d === null) return false;
    if (typeof d.field !== "string" || !d.field) return false;
    if (typeof d.map !== "object" || d.map === null) return false;
    if (!Object.values(d.map).every((k) => KINDS.includes(k as ContentKind)))
      return false;
  }
  return r.kind !== undefined || r.discriminator !== undefined;
};

/**
 * Validate a detection rules configuration string.
 * Returns an error description, or undefined if the value is acceptable.
 * An empty value is valid and means the built-in DEFAULT_RULES apply.
 */
export const validateRules = (text: string): string | undefined => {
  if (!text.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return "Detection rules must be valid JSON";
  }
  if (!Array.isArray(parsed)) return "Detection rules must be a JSON array";
  for (let i = 0; i < parsed.length; i++) {
    if (!isDetectionRule(parsed[i]))
      return `Rule ${i + 1} must have a schema pattern, a non-empty paths list, and a kind or discriminator`;
  }
  return undefined;
};

/**
 * Parse a detection rules configuration string.
 * Returns null when empty or invalid, in which case DEFAULT_RULES should apply.
 */
export const parseRules = (text: string): DetectionRule[] | null => {
  if (!text.trim() || validateRules(text) !== undefined) return null;
  return JSON.parse(text) as DetectionRule[];
};
