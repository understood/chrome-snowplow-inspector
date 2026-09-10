import { normalizeFieldName } from "./rules";
import type {
  ContentfulSpace,
  ContentKind,
  FieldSpec,
  ResolvedContent,
  ResolvedField,
} from "./types";

const REQUEST_TIMEOUT_MS = 5000;
const DELIVERY_HOST = "https://cdn.contentful.com";
const PREVIEW_HOST = "https://preview.contentful.com";
const APP_HOST = "https://app.contentful.com";
const MAX_RATE_LIMIT_WAIT_S = 10;

type ContentTypeInfo = { name: string; displayField?: string };

/** Recognise a Contentful reference field, e.g. { sys: { type: "Link", ... } }. */
const linkSys = (
  value: unknown,
): { id: string; linkType: string } | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const sys = (value as { sys?: unknown }).sys;
  if (typeof sys !== "object" || sys === null) return undefined;
  const { type, linkType, id } = sys as Record<string, unknown>;
  if (type !== "Link" || typeof id !== "string" || typeof linkType !== "string")
    return undefined;
  return { id, linkType };
};

/**
 * Minimal Contentful Delivery/Preview API client for a single space.
 * Lookups never reject; failures are reported as ResolvedContent errors so
 * the ContentResolver can fall through to other configured spaces.
 */
export class SpaceClient {
  readonly spec: ContentfulSpace;
  private healthy = true;
  private contentTypes?: Promise<Map<string, ContentTypeInfo>>;
  private readonly extra: FieldSpec[];

  constructor(spec: ContentfulSpace, extraFields: FieldSpec[] = []) {
    this.spec = spec;
    this.extra = extraFields;
  }

  get label(): string {
    return this.spec.label || this.spec.spaceId;
  }

  get environment(): string {
    return this.spec.environment || "master";
  }

  private apiFetch(
    host: string,
    token: string,
    path: string,
    retried = false,
  ): Promise<Response> {
    const ac = new AbortController();
    const id = setTimeout(ac.abort.bind(ac), REQUEST_TIMEOUT_MS);

    const url = `${host}/spaces/${this.spec.spaceId}/environments/${this.environment}${path}`;

    return fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      referrerPolicy: "origin",
      signal: ac.signal,
    }).then(
      (resp) => {
        clearTimeout(id);
        if (resp.status === 401 || resp.status === 403) {
          // bad credentials won't get better this session, stop asking
          this.healthy = false;
          return Promise.reject(
            new Error(
              `authorization failed (HTTP ${resp.status}), check the space's API tokens`,
            ),
          );
        }
        if (resp.status === 429 && !retried) {
          const parsed = parseFloat(
            resp.headers.get("X-Contentful-RateLimit-Reset") || "",
          );
          const reset = Math.min(
            Number.isFinite(parsed) && parsed >= 0 ? parsed : 1,
            MAX_RATE_LIMIT_WAIT_S,
          );
          return new Promise<void>((fulfil) =>
            setTimeout(fulfil, reset * 1000),
          ).then(() => this.apiFetch(host, token, path, true));
        }
        return resp;
      },
      (err) => {
        clearTimeout(id);
        return Promise.reject(err);
      },
    );
  }

  private types(): Promise<Map<string, ContentTypeInfo>> {
    if (!this.contentTypes) {
      this.contentTypes = this.apiFetch(
        DELIVERY_HOST,
        this.spec.deliveryToken,
        "/content_types?limit=1000",
      )
        .then((resp) => (resp.ok ? resp.json() : Promise.reject("HTTP_ERROR")))
        .then((json) => {
          const map = new Map<string, ContentTypeInfo>();
          for (const ct of json.items || []) {
            if (ct.sys && ct.sys.id)
              map.set(ct.sys.id, {
                name: ct.name || ct.sys.id,
                displayField: ct.displayField,
              });
          }
          return map;
        })
        .catch(() => {
          // allow another attempt later rather than caching the failure
          this.contentTypes = undefined;
          return new Map<string, ContentTypeInfo>();
        });
    }
    return this.contentTypes;
  }

  lookup(id: string, kind: ContentKind): Promise<ResolvedContent> {
    if (!this.healthy)
      return Promise.resolve({
        status: "error",
        id,
        message: `Contentful space "${this.label}" disabled after an authorization failure`,
      });

    switch (kind) {
      case "content-type":
        return this.lookupContentType(id);
      case "asset":
        return this.lookupResource(id, "asset");
      case "entry":
        return this.lookupResource(id, "entry");
    }
  }

  private lookupContentType(id: string): Promise<ResolvedContent> {
    return this.types().then((types) => {
      // types() swallows fetch failures; don't report auth problems as notfound
      if (!this.healthy)
        return {
          status: "error" as const,
          id,
          message: `Contentful space "${this.label}" disabled after an authorization failure`,
        };
      const ct = types.get(id);
      if (!ct) return { status: "notfound", id };
      return {
        status: "resolved",
        id,
        kind: "content-type",
        title: ct.name,
        contentType: "Content Type",
        spaceLabel: this.label,
        draft: false,
        url: this.appUrl("content_types", id) + "/fields",
      };
    });
  }

  private lookupResource(
    id: string,
    kind: "entry" | "asset",
  ): Promise<ResolvedContent> {
    return this.probe(DELIVERY_HOST, this.spec.deliveryToken, kind, id).then(
      (result) =>
        result.status === "notfound" && this.spec.previewToken
          ? this.probe(PREVIEW_HOST, this.spec.previewToken, kind, id, true)
          : result,
    );
  }

  private probe(
    host: string,
    token: string,
    kind: "entry" | "asset",
    id: string,
    draft = false,
  ): Promise<ResolvedContent> {
    const collection = kind === "asset" ? "assets" : "entries";
    return this.apiFetch(
      host,
      token,
      `/${collection}/${encodeURIComponent(id)}`,
    )
      .then<ResolvedContent>((resp) => {
        if (resp.status === 404) return { status: "notfound" as const, id };
        if (!resp.ok)
          return {
            status: "error" as const,
            id,
            message: `Contentful space "${this.label}" responded with HTTP ${resp.status}`,
          };
        return resp
          .json()
          .then((json) =>
            kind === "asset"
              ? this.assetResult(json, id, draft)
              : this.entryResult(json, id, draft),
          );
      })
      .catch((err) => ({
        status: "error",
        id,
        message: `Contentful lookup in "${this.label}" failed: ${err && (err as Error).message ? (err as Error).message : String(err)}`,
      }));
  }

  /**
   * Pick out the configured extra fields this resource actually carries,
   * reporting them under their real API ids. A configured name matches
   * loosely, so "Page key" as shown in Contentful finds `pageKey`.
   *
   * Links, arrays and rich text are skipped: they would only render as
   * opaque objects, and resolving them would cost another request each.
   */
  private extraFields(
    fields: Record<string, unknown>,
  ): Promise<ResolvedField[] | undefined> {
    const byNormal = new Map<string, string>();
    for (const key of Object.keys(fields)) {
      const normal = normalizeFieldName(key);
      // on collision the first field wins, following the entry's own order
      if (!byNormal.has(normal)) byNormal.set(normal, key);
    }

    const pending: Promise<ResolvedField | undefined>[] = [];
    const seen = new Set<string>();
    for (const { name, label } of this.extra) {
      const field =
        name in fields ? name : byNormal.get(normalizeFieldName(name));
      if (field === undefined || seen.has(field)) continue;
      seen.add(field);

      const value = fields[field];
      if (typeof value === "string") {
        if (value) pending.push(Promise.resolve({ field, label, value }));
      } else if (typeof value === "number" || typeof value === "boolean") {
        pending.push(Promise.resolve({ field, label, value: String(value) }));
      } else {
        // arrays and rich text stay skipped; a single reference resolves
        const link = linkSys(value);
        if (link) pending.push(this.linkField(field, label, link));
      }
    }

    return Promise.all(pending).then((found) => {
      const list = found.filter((f): f is ResolvedField => f !== undefined);
      return list.length ? list : undefined;
    });
  }

  /**
   * Resolve a reference field to its target's title, linked to Contentful.
   * Falls back to the bare id when the target can't be read, so a broken or
   * unpublished reference still shows something useful.
   */
  private linkField(
    field: string,
    label: string | undefined,
    link: { id: string; linkType: string },
  ): Promise<ResolvedField> {
    const kind = link.linkType === "Asset" ? "asset" : "entry";
    const url = this.appUrl(kind === "asset" ? "assets" : "entries", link.id);
    return this.targetTitle(link.id, kind).then((title) => ({
      field,
      label,
      value: title || link.id,
      url,
    }));
  }

  /**
   * Title of a linked entry or asset. Deliberately does not run extraFields
   * on the target: link fields resolve one level only, so a reference cycle
   * cannot fan out into unbounded requests.
   */
  private targetTitle(
    id: string,
    kind: "entry" | "asset",
  ): Promise<string | undefined> {
    const collection = kind === "asset" ? "assets" : "entries";
    const read = (host: string, token: string) =>
      this.apiFetch(
        host,
        token,
        `/${collection}/${encodeURIComponent(id)}`,
      ).then((resp) => (resp.ok ? resp.json() : Promise.reject("HTTP_ERROR")));

    return read(DELIVERY_HOST, this.spec.deliveryToken)
      .catch(() =>
        this.spec.previewToken
          ? read(PREVIEW_HOST, this.spec.previewToken)
          : Promise.reject("HTTP_ERROR"),
      )
      .then((json) => {
        if (kind === "asset") {
          const title = (json.fields || {}).title;
          return typeof title === "string" ? title : undefined;
        }
        return this.types().then((types) => this.entryTitle(json, types).title);
      })
      .catch(() => undefined);
  }

  /** An entry's display title and content type name from its payload. */
  private entryTitle(
    json: any,
    types: Map<string, ContentTypeInfo>,
  ): { title: string | undefined; contentType: string | undefined } {
    const ctId: string | undefined =
      json.sys && json.sys.contentType && json.sys.contentType.sys
        ? json.sys.contentType.sys.id
        : undefined;
    const ct = ctId ? types.get(ctId) : undefined;
    const fields: Record<string, unknown> = json.fields || {};
    let title: unknown =
      ct && ct.displayField ? fields[ct.displayField] : undefined;
    if (typeof title !== "string")
      title = Object.values(fields).find((v) => typeof v === "string");
    return {
      title: typeof title === "string" ? title : undefined,
      contentType: ct ? ct.name : ctId,
    };
  }

  private entryResult(
    json: any,
    id: string,
    draft: boolean,
  ): Promise<ResolvedContent> {
    const fields: Record<string, unknown> = json.fields || {};
    return this.types()
      .then((types) => this.entryTitle(json, types))
      .then(({ title, contentType }) =>
        this.extraFields(fields).then((meta) => ({
          status: "resolved" as const,
          id,
          kind: "entry" as const,
          title: title || id,
          contentType,
          spaceLabel: this.label,
          draft,
          url: this.appUrl("entries", id),
          meta,
        })),
      );
  }

  private assetResult(
    json: any,
    id: string,
    draft: boolean,
  ): Promise<ResolvedContent> {
    const fields: Record<string, unknown> = json.fields || {};
    const title = fields.title;
    return this.extraFields(fields).then((meta) => ({
      status: "resolved" as const,
      id,
      kind: "asset" as const,
      title: typeof title === "string" ? title : id,
      contentType: "Asset",
      spaceLabel: this.label,
      draft,
      url: this.appUrl("assets", id),
      meta,
    }));
  }

  private appUrl(collection: string, id: string): string {
    return `${APP_HOST}/spaces/${this.spec.spaceId}/environments/${this.environment}/${collection}/${encodeURIComponent(id)}`;
  }
}
