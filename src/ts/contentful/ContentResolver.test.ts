import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";

import { ContentResolver } from "./ContentResolver";
import type { ContentfulSpace } from "./types";

const MAIN: ContentfulSpace = {
  label: "Main",
  spaceId: "mainspace",
  environment: "master",
  deliveryToken: "main-delivery",
  previewToken: "main-preview",
};

const BLOG: ContentfulSpace = {
  label: "Blog",
  spaceId: "blogspace",
  environment: "master",
  deliveryToken: "blog-delivery",
};

const CONTENT_TYPES = {
  items: [{ sys: { id: "article" }, name: "Article", displayField: "title" }],
};

const entry = (id: string, fields: Record<string, unknown>) => ({
  sys: { id, contentType: { sys: { id: "article" } } },
  fields,
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const status = (code: number, headers: Record<string, string> = {}) =>
  new Response("{}", { status: code, headers });

type Route = (url: string, auth: string) => Response | undefined;

let fetchMock: jest.Mock<
  (url: string, opts?: RequestInit) => Promise<Response>
>;

const route = (handler: Route) => {
  fetchMock.mockImplementation((url, opts) => {
    const auth = String(
      (opts?.headers as Record<string, string>)?.Authorization || "",
    ).replace("Bearer ", "");
    const resp = handler(String(url), auth);
    return resp ? Promise.resolve(resp) : Promise.resolve(status(404));
  });
};

const makeResolver = async (spaces: ContentfulSpace[], rules = "") => {
  (chrome.storage.sync.get as any).mockImplementation(
    (defaults: any, cb: any) =>
      cb({ ...defaults, contentfulSpaces: spaces, contentfulRules: rules }),
  );
  const resolver = new ContentResolver();
  await resolver.ready;
  return resolver;
};

const entryCalls = (host = "") =>
  fetchMock.mock.calls.filter(
    ([url]) => String(url).includes("/entries/") && String(url).includes(host),
  );

describe("ContentResolver", () => {
  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    (chrome.storage.local.set as any).mockClear();
    (chrome.storage.local.get as any).mockImplementation(
      (defaults: any, cb: any) => cb(defaults),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("is a no-op when no spaces are configured", async () => {
    const resolver = await makeResolver([]);
    expect(resolver.configured).toBe(false);

    const result = await resolver.lookup("someid", "entry");
    expect(result.status).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("resolves entry titles via the content type displayField", async () => {
    route((url) => {
      if (url.includes("/content_types")) return json(CONTENT_TYPES);
      if (url.includes("/entries/abc123"))
        return json(entry("abc123", { slug: "x", title: "Hello World" }));
      return undefined;
    });

    const resolver = await makeResolver([MAIN]);
    expect(resolver.configured).toBe(true);

    const result = await resolver.lookup("abc123", "entry");
    expect(result).toMatchObject({
      status: "resolved",
      title: "Hello World",
      contentType: "Article",
      spaceLabel: "Main",
      draft: false,
      url: "https://app.contentful.com/spaces/mainspace/environments/master/entries/abc123",
    });
  });

  test("falls back to the first string field for unknown content types", async () => {
    route((url) => {
      if (url.includes("/content_types")) return json({ items: [] });
      if (url.includes("/entries/abc123"))
        return json(entry("abc123", { count: 3, name: "First String" }));
      return undefined;
    });

    const resolver = await makeResolver([MAIN]);
    const result = await resolver.lookup("abc123", "entry");
    expect(result).toMatchObject({
      status: "resolved",
      title: "First String",
      contentType: "article",
    });
  });

  test("probes spaces in order, falling through on 404", async () => {
    route((url) => {
      if (url.includes("/content_types")) return json(CONTENT_TYPES);
      if (url.includes("blogspace") && url.includes("/entries/blogid"))
        return json(entry("blogid", { title: "Blog Post" }));
      return undefined;
    });

    const resolver = await makeResolver([MAIN, BLOG]);
    const result = await resolver.lookup("blogid", "entry");

    expect(result).toMatchObject({
      status: "resolved",
      title: "Blog Post",
      spaceLabel: "Blog",
    });

    // main is probed first (delivery then preview) before falling through
    const probes = entryCalls().map(([url]) => String(url));
    expect(probes[0]).toContain("cdn.contentful.com/spaces/mainspace");
    expect(probes[1]).toContain("preview.contentful.com/spaces/mainspace");
    expect(probes[2]).toContain("cdn.contentful.com/spaces/blogspace");
  });

  test("returns notfound when no space has the id and does not persist it", async () => {
    route((url) =>
      url.includes("/content_types") ? json(CONTENT_TYPES) : undefined,
    );

    const resolver = await makeResolver([BLOG]);
    const result = await resolver.lookup("missing", "entry");
    expect(result).toEqual({ status: "notfound", id: "missing" });
    expect(chrome.storage.local.set).not.toHaveBeenCalled();

    // negative result is cached in memory for the TTL
    const calls = entryCalls().length;
    await resolver.lookup("missing", "entry");
    expect(entryCalls().length).toBe(calls);
  });

  test("falls back to the preview API and flags drafts", async () => {
    route((url, auth) => {
      if (url.includes("/content_types")) return json(CONTENT_TYPES);
      if (
        url.startsWith("https://preview.contentful.com/") &&
        url.includes("/entries/draftid") &&
        auth === "main-preview"
      )
        return json(entry("draftid", { title: "Unpublished" }));
      return undefined;
    });

    const resolver = await makeResolver([MAIN]);
    const result = await resolver.lookup("draftid", "entry");
    expect(result).toMatchObject({
      status: "resolved",
      title: "Unpublished",
      draft: true,
    });
    expect(entryCalls("cdn.contentful.com").length).toBe(1);
    expect(entryCalls("preview.contentful.com").length).toBe(1);
  });

  test("resolves assets", async () => {
    route((url) => {
      if (url.includes("/assets/assetid"))
        return json({ sys: { id: "assetid" }, fields: { title: "A PDF" } });
      return undefined;
    });

    const resolver = await makeResolver([MAIN]);
    const result = await resolver.lookup("assetid", "asset");
    expect(result).toMatchObject({
      status: "resolved",
      title: "A PDF",
      contentType: "Asset",
      url: "https://app.contentful.com/spaces/mainspace/environments/master/assets/assetid",
    });
  });

  test("resolves content types from the cached index", async () => {
    route((url) =>
      url.includes("/content_types") ? json(CONTENT_TYPES) : undefined,
    );

    const resolver = await makeResolver([MAIN]);
    const result = await resolver.lookup("article", "content-type");
    expect(result).toMatchObject({
      status: "resolved",
      title: "Article",
      kind: "content-type",
    });

    const unknown = await resolver.lookup("nosuchtype", "content-type");
    expect(unknown.status).toBe("notfound");
  });

  test("disables a space for the session after an auth failure", async () => {
    route(() => status(401));

    const resolver = await makeResolver([BLOG]);
    const first = await resolver.lookup("id-one", "entry");
    expect(first.status).toBe("error");

    const calls = fetchMock.mock.calls.length;
    const second = await resolver.lookup("id-two", "entry");
    expect(second.status).toBe("error");
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  test("reports auth failures on content type lookups as errors, not notfound", async () => {
    route(() => status(401));

    const resolver = await makeResolver([MAIN]);
    const result = await resolver.lookup("article", "content-type");
    expect(result.status).toBe("error");
  });

  test("retries once after a 429, honouring the rate limit reset", async () => {
    let attempts = 0;
    route((url) => {
      if (url.includes("/content_types")) return json(CONTENT_TYPES);
      if (url.includes("/entries/limited")) {
        attempts++;
        return attempts === 1
          ? status(429, { "X-Contentful-RateLimit-Reset": "0" })
          : json(entry("limited", { title: "Eventually" }));
      }
      return undefined;
    });

    const resolver = await makeResolver([BLOG]);
    const result = await resolver.lookup("limited", "entry");
    expect(result).toMatchObject({ status: "resolved", title: "Eventually" });
    expect(attempts).toBe(2);
  });

  test("falls back to a short wait when the rate limit header is malformed", async () => {
    let attempts = 0;
    route((url) => {
      if (url.includes("/content_types")) return json(CONTENT_TYPES);
      if (url.includes("/entries/limited")) {
        attempts++;
        return attempts === 1
          ? status(429, { "X-Contentful-RateLimit-Reset": "soon" })
          : json(entry("limited", { title: "Eventually" }));
      }
      return undefined;
    });

    const resolver = await makeResolver([BLOG]);
    const result = await resolver.lookup("limited", "entry");
    expect(result).toMatchObject({ status: "resolved", title: "Eventually" });
    expect(attempts).toBe(2);
  }, 10000);

  test("bounds the in-memory cache size", async () => {
    route((url) =>
      url.includes("/content_types") ? json(CONTENT_TYPES) : undefined,
    );

    const resolver = await makeResolver([BLOG]);
    for (let i = 0; i < 1100; i++) await resolver.lookup(`id${i}`, "entry");

    expect((resolver as any).lookups.size).toBeLessThanOrEqual(1000);
  }, 30000);

  test("coalesces concurrent lookups for the same id", async () => {
    route((url) => {
      if (url.includes("/content_types")) return json(CONTENT_TYPES);
      if (url.includes("/entries/abc123"))
        return json(entry("abc123", { title: "Hello" }));
      return undefined;
    });

    const resolver = await makeResolver([MAIN]);
    const p1 = resolver.lookup("abc123", "entry");
    const p2 = resolver.lookup("abc123", "entry");
    expect(p1).toBe(p2);

    await p1;
    expect(entryCalls().length).toBe(1);
  });

  test("caches positive results, persists them, and expires them", async () => {
    let now = 1_700_000_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);

    route((url) => {
      if (url.includes("/content_types")) return json(CONTENT_TYPES);
      if (url.includes("/entries/abc123"))
        return json(entry("abc123", { title: "Hello" }));
      return undefined;
    });

    const resolver = await makeResolver([MAIN]);
    await resolver.lookup("abc123", "entry");

    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      contentfulCache: expect.objectContaining({
        "entry:abc123": expect.objectContaining({
          result: expect.objectContaining({ status: "resolved" }),
        }),
      }),
    });

    // within the TTL: served from cache
    await resolver.lookup("abc123", "entry");
    expect(entryCalls().length).toBe(1);

    // after the TTL: refetched
    now += 2 * 60 * 60 * 1000;
    await resolver.lookup("abc123", "entry");
    expect(entryCalls().length).toBe(2);
  });
});
