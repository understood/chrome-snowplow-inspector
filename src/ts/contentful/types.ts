export type ContentfulSpace = {
  label: string;
  spaceId: string;
  environment: string;
  deliveryToken: string;
  previewToken?: string;
};

export type ContentKind = "entry" | "asset" | "content-type";

export type DetectionRule = {
  /** Iglu URI pattern; segments may contain `*` wildcards, e.g. iglu:org.understood/content/jsonschema/1-* */
  schema: string;
  /** Dot-separated paths into the entity data; `*` matches any single key or array index, e.g. data.*.id */
  paths: string[];
  /** Fixed kind for all matched values */
  kind?: ContentKind;
  /** Derive the kind from a sibling field of the matched value, e.g. { field: "type", map: { entry: "entry" } } */
  discriminator?: {
    field: string;
    map: Record<string, ContentKind>;
  };
};

export type ResolvedContent =
  | {
      status: "resolved";
      id: string;
      kind: ContentKind;
      title: string;
      contentType?: string;
      spaceLabel: string;
      draft: boolean;
      url: string;
    }
  | { status: "notfound"; id: string }
  | { status: "error"; id: string; message: string };
