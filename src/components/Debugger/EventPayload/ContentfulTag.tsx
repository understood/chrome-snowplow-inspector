import { Fragment, h, type FunctionComponent } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";

import { resolveKind } from "../../../ts/contentful";
import type { ResolvedContent } from "../../../ts/contentful";
import { ContentfulContext } from "../../ContentfulContext";

/**
 * Decorates a string value in the event detail view with the resolved
 * Contentful entry/asset/content-type it references, linked to the entry
 * in the Contentful web app. Renders nothing unless a configured detection
 * rule matches the value's location in its entity.
 */
export const ContentfulTag: FunctionComponent<{
  value: string;
  schema?: string;
  path?: string;
  parent?: unknown;
}> = ({ value, schema, path, parent }) => {
  const resolver = useContext(ContentfulContext);
  const [, setVersion] = useState(0);
  const [result, setResult] = useState<ResolvedContent>();

  useEffect(
    () =>
      resolver ? resolver.subscribe(() => setVersion((v) => v + 1)) : undefined,
    [resolver],
  );

  const rule =
    resolver && resolver.configured && schema && path
      ? resolver.match(schema, path)
      : undefined;
  const kind = rule ? resolveKind(rule, parent) : undefined;

  useEffect(() => {
    if (!resolver || !kind || !value) return;
    let cancelled = false;
    resolver.lookup(value, kind).then((resolved) => {
      if (!cancelled) setResult(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [resolver, value, kind]);

  if (!kind || !result || result.id !== value) return null;

  if (result.status === "error")
    return (
      <span
        class="contentful contentful--error"
        title={result.message}
        role="img"
        aria-label={`Contentful lookup failed: ${result.message}`}
      >
        ⚠️
      </span>
    );

  if (result.status !== "resolved") return null;

  return (
    <span class="contentful contentful--resolved">
      <a
        class="contentful__link"
        href={result.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open in Contentful (${result.spaceLabel})`}
      >
        {result.title}
        {result.contentType && (
          <span class="contentful__type">{result.contentType}</span>
        )}
        {result.draft && <span class="contentful__draft">Draft</span>}
      </a>
      {result.meta && (
        <span class="contentful__fields">
          {result.meta.map(({ field, label, value, url }) => (
            <Fragment key={field}>
              <span class="contentful__field" title={field}>
                {label || field}
              </span>
              {url ? (
                <a
                  class="contentful__value contentful__value--link"
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open the referenced entry in Contentful"
                >
                  {value}
                </a>
              ) : (
                <span class="contentful__value">{value}</span>
              )}
            </Fragment>
          ))}
        </span>
      )}
    </span>
  );
};
