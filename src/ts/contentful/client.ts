import type { ContentfulSpace, ContentKind, ResolvedContent } from "./types";

const REQUEST_TIMEOUT_MS = 5000;
const DELIVERY_HOST = "https://cdn.contentful.com";
const PREVIEW_HOST = "https://preview.contentful.com";
const APP_HOST = "https://app.contentful.com";
const MAX_RATE_LIMIT_WAIT_S = 10;

type ContentTypeInfo = { name: string; displayField?: string };

/**
 * Minimal Contentful Delivery/Preview API client for a single space.
 * Lookups never reject; failures are reported as ResolvedContent errors so
 * the ContentResolver can fall through to other configured spaces.
 */
export class SpaceClient {
  readonly spec: ContentfulSpace;
  private healthy = true;
  private contentTypes?: Promise<Map<string, ContentTypeInfo>>;

  constructor(spec: ContentfulSpace) {
    this.spec = spec;
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
          const reset = Math.min(
            parseFloat(resp.headers.get("X-Contentful-RateLimit-Reset") || "1"),
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

  private entryResult(
    json: any,
    id: string,
    draft: boolean,
  ): Promise<ResolvedContent> {
    const ctId: string | undefined =
      json.sys && json.sys.contentType && json.sys.contentType.sys
        ? json.sys.contentType.sys.id
        : undefined;
    return this.types().then((types) => {
      const ct = ctId ? types.get(ctId) : undefined;
      const fields: Record<string, unknown> = json.fields || {};
      let title: unknown =
        ct && ct.displayField ? fields[ct.displayField] : undefined;
      if (typeof title !== "string")
        title = Object.values(fields).find((v) => typeof v === "string");

      return {
        status: "resolved",
        id,
        kind: "entry",
        title: typeof title === "string" ? title : id,
        contentType: ct ? ct.name : ctId,
        spaceLabel: this.label,
        draft,
        url: this.appUrl("entries", id),
      };
    });
  }

  private assetResult(json: any, id: string, draft: boolean): ResolvedContent {
    const fields: Record<string, unknown> = json.fields || {};
    const title = fields.title;
    return {
      status: "resolved",
      id,
      kind: "asset",
      title: typeof title === "string" ? title : id,
      contentType: "Asset",
      spaceLabel: this.label,
      draft,
      url: this.appUrl("assets", id),
    };
  }

  private appUrl(collection: string, id: string): string {
    return `${APP_HOST}/spaces/${this.spec.spaceId}/environments/${this.environment}/${collection}/${encodeURIComponent(id)}`;
  }
}
