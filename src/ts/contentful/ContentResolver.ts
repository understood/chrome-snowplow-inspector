import { SpaceClient } from "./client";
import { DEFAULT_RULES, matchRule, parseRules } from "./rules";
import type {
  ContentfulSpace,
  ContentKind,
  DetectionRule,
  ResolvedContent,
} from "./types";

const POSITIVE_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;

type CacheEntry = { expires: number; result: ResolvedContent };
type PendingEntry = { expires: number; promise: Promise<ResolvedContent> };

const SYNC_DEFAULTS = {
  contentfulSpaces: [] as ContentfulSpace[],
  contentfulRules: "",
};

/**
 * Resolves Contentful entry/asset/content-type IDs found in event payloads
 * to human-readable titles, probing every configured space in order.
 *
 * Configuration lives in chrome.storage.sync (options page) and is
 * hot-reloaded when it changes. With no spaces configured, everything
 * is a no-op.
 */
export class ContentResolver {
  private clients: SpaceClient[] = [];
  private rules: DetectionRule[] = DEFAULT_RULES;
  private readonly lookups: Map<string, PendingEntry> = new Map();
  private readonly hitCache: Map<string, SpaceClient> = new Map();
  private persisted: Record<string, CacheEntry> = {};
  private readonly listeners: Set<() => void> = new Set();
  readonly ready: Promise<void>;

  constructor() {
    this.ready = Promise.all([
      this.loadConfig(),
      new Promise<void>((fulfil) =>
        chrome.storage.local.get({ contentfulCache: {} }, (stored) => {
          const cache: Record<string, CacheEntry> =
            (stored && stored.contentfulCache) || {};
          const now = Date.now();
          for (const [key, entry] of Object.entries(cache)) {
            if (entry.expires > now) this.persisted[key] = entry;
          }
          fulfil();
        }),
      ),
    ]).then(() => this.notify());

    if (chrome.storage.onChanged)
      chrome.storage.onChanged.addListener((changes, area) => {
        if (
          area === "sync" &&
          ("contentfulSpaces" in changes || "contentfulRules" in changes)
        )
          this.loadConfig().then(() => this.notify());
      });
  }

  private loadConfig(): Promise<void> {
    return new Promise((fulfil) =>
      chrome.storage.sync.get(
        SYNC_DEFAULTS,
        ({ contentfulSpaces, contentfulRules }) => {
          this.clients = ((contentfulSpaces as ContentfulSpace[]) || [])
            .filter((space) => space.spaceId && space.deliveryToken)
            .map((space) => new SpaceClient(space));
          this.rules = parseRules(contentfulRules || "") ?? DEFAULT_RULES;
          this.lookups.clear();
          this.hitCache.clear();
          fulfil();
        },
      ),
    );
  }

  /** Re-render hook for components: fires after (re)configuration. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((listener) => listener());
  }

  get configured(): boolean {
    return this.clients.length > 0;
  }

  match(schema: string, path: string): DetectionRule | undefined {
    return matchRule(this.rules, schema, path);
  }

  lookup(id: string, kind: ContentKind): Promise<ResolvedContent> {
    const key = `${kind}:${id}`;
    const now = Date.now();

    if (this.lookups.size >= MAX_CACHE_ENTRIES) this.evict();

    const pending = this.lookups.get(key);
    if (pending && pending.expires > now) return pending.promise;

    const cached = this.persisted[key];
    if (cached && cached.expires > now) {
      const entry = {
        expires: cached.expires,
        promise: Promise.resolve(cached.result),
      };
      this.lookups.set(key, entry);
      return entry.promise;
    }

    const entry: PendingEntry = {
      // coalesce concurrent lookups while in flight; adjusted on settle
      expires: now + NEGATIVE_TTL_MS,
      promise: this.probeSpaces(id, kind),
    };
    this.lookups.set(key, entry);

    entry.promise.then((result) => {
      if (this.lookups.get(key) !== entry) return;
      if (result.status === "resolved") {
        entry.expires = Date.now() + POSITIVE_TTL_MS;
        this.persist(key, { expires: entry.expires, result });
      } else {
        entry.expires = Date.now() + NEGATIVE_TTL_MS;
      }
    });

    return entry.promise;
  }

  private async probeSpaces(
    id: string,
    kind: ContentKind,
  ): Promise<ResolvedContent> {
    if (!this.clients.length)
      return {
        status: "error",
        id,
        message: "No Contentful spaces configured",
      };

    const key = `${kind}:${id}`;
    const hit = this.hitCache.get(key);
    const candidates = hit
      ? [hit, ...this.clients.filter((client) => client !== hit)]
      : this.clients;

    let error: ResolvedContent | undefined;
    for (const client of candidates) {
      const result = await client.lookup(id, kind);
      if (result.status === "resolved") {
        this.hitCache.set(key, client);
        return result;
      }
      if (result.status === "error") error = error || result;
    }

    return error || { status: "notfound", id };
  }

  /** Drop expired entries, then soonest-expiring ones to stay under the cap. */
  private evict() {
    const now = Date.now();
    for (const [key, entry] of this.lookups) {
      if (entry.expires <= now) this.lookups.delete(key);
    }
    const excess = this.lookups.size - MAX_CACHE_ENTRIES + 1;
    if (excess > 0) {
      const oldest = [...this.lookups.entries()]
        .sort((a, b) => a[1].expires - b[1].expires)
        .slice(0, excess);
      for (const [key] of oldest) this.lookups.delete(key);
    }
  }

  private persist(key: string, entry: CacheEntry) {
    const now = Date.now();
    for (const [k, e] of Object.entries(this.persisted)) {
      if (e.expires <= now) delete this.persisted[k];
    }
    this.persisted[key] = entry;
    const entries = Object.entries(this.persisted);
    const excess = entries.length - MAX_CACHE_ENTRIES;
    if (excess > 0) {
      const oldest = entries
        .sort((a, b) => a[1].expires - b[1].expires)
        .slice(0, excess);
      for (const [k] of oldest) delete this.persisted[k];
    }
    chrome.storage.local.set({ contentfulCache: this.persisted });
  }
}
