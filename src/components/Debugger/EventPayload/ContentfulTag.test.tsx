import { describe, expect, jest, test } from "@jest/globals";
import { render, screen } from "@testing-library/preact";

import { h } from "preact";

import { ContentfulTag } from "./ContentfulTag";
import { ContentfulContext } from "../../ContentfulContext";
import { DEFAULT_RULES, matchRule } from "../../../ts/contentful";
import type { ContentResolver, ResolvedContent } from "../../../ts/contentful";

const CONTENT_REFERENCE_V2 =
  "iglu:org.understood/content_reference/jsonschema/2-0-0";

const RESOLVED: ResolvedContent = {
  status: "resolved",
  id: "3K9dOxAbCd",
  kind: "entry",
  title: "What is dyslexia?",
  contentType: "Article",
  spaceLabel: "Main",
  draft: false,
  url: "https://app.contentful.com/spaces/p0qf7j048i0q/environments/master/entries/3K9dOxAbCd",
};

const stubResolver = (
  result: ResolvedContent = RESOLVED,
  overrides: Partial<Record<"configured", boolean>> = {},
) => {
  const lookup = jest.fn((_id: string, _kind: string) =>
    Promise.resolve(result),
  );
  const resolver = {
    configured: true,
    match: (schema: string, path: string) =>
      matchRule(DEFAULT_RULES, schema, path),
    subscribe: () => () => {},
    lookup,
    ...overrides,
  } as unknown as ContentResolver;
  return { resolver, lookup };
};

const renderTag = (
  resolver: ContentResolver | null,
  props: Partial<{
    value: string;
    schema: string;
    path: string;
    parent: unknown;
  }> = {},
) => {
  const tag = (
    <ContentfulTag
      value="3K9dOxAbCd"
      schema={CONTENT_REFERENCE_V2}
      path="id"
      parent={{ id: "3K9dOxAbCd", type: "entry" }}
      {...props}
    />
  );
  return render(
    resolver ? (
      <ContentfulContext.Provider value={resolver}>
        {tag}
      </ContentfulContext.Provider>
    ) : (
      tag
    ),
  );
};

describe("ContentfulTag", () => {
  test("renders a linked title with content type for resolved ids", async () => {
    const { resolver, lookup } = stubResolver();
    renderTag(resolver);

    const link = await screen.findByRole("link");
    expect(link.getAttribute("href")).toBe(RESOLVED.url);
    expect(link.textContent).toContain("What is dyslexia?");
    expect(link.textContent).toContain("Article");
    expect(lookup).toHaveBeenCalledWith("3K9dOxAbCd", "entry");
  });

  test("shows a draft badge for preview-only entries", async () => {
    const { resolver } = stubResolver({ ...RESOLVED, draft: true });
    renderTag(resolver);

    const link = await screen.findByRole("link");
    expect(link.textContent).toContain("Draft");
  });

  test("renders nothing without a configured resolver", async () => {
    const { resolver, lookup } = stubResolver(RESOLVED, { configured: false });
    const { container } = renderTag(resolver);

    await Promise.resolve();
    expect(container.innerHTML).toBe("");
    expect(lookup).not.toHaveBeenCalled();
  });

  test("renders nothing without a context provider", async () => {
    const { container } = renderTag(null);

    await Promise.resolve();
    expect(container.innerHTML).toBe("");
  });

  test("renders nothing for unmatched paths", async () => {
    const { resolver, lookup } = stubResolver();
    const { container } = renderTag(resolver, { path: "type" });

    await Promise.resolve();
    expect(container.innerHTML).toBe("");
    expect(lookup).not.toHaveBeenCalled();
  });

  test("renders nothing for unknown discriminator types", async () => {
    const { resolver, lookup } = stubResolver();
    const { container } = renderTag(resolver, {
      parent: { id: "3K9dOxAbCd", type: "topic" },
    });

    await Promise.resolve();
    expect(container.innerHTML).toBe("");
    expect(lookup).not.toHaveBeenCalled();
  });

  test("renders nothing for notfound ids", async () => {
    const { resolver, lookup } = stubResolver({
      status: "notfound",
      id: "3K9dOxAbCd",
    });
    const { container } = renderTag(resolver);

    await Promise.resolve();
    await Promise.resolve();
    expect(lookup).toHaveBeenCalled();
    expect(container.querySelector(".contentful")).toBeNull();
  });

  test("renders a warning with details for lookup errors", async () => {
    const { resolver } = stubResolver({
      status: "error",
      id: "3K9dOxAbCd",
      message: "HTTP 500",
    });
    renderTag(resolver);

    const warning = await screen.findByTitle("HTTP 500");
    expect(warning.textContent).toContain("⚠️");
  });
});
