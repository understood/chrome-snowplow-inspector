import { h, render } from "preact";
import { useEffect, useState } from "preact/hooks";

import "./options.css";

import { utmify } from "./ts/analytics";
import { DEFAULT_FIELDS, DEFAULT_RULES, validateRules } from "./ts/contentful";

type ContentfulSpaceOption = {
  label: string;
  spaceId: string;
  environment: string;
  deliveryToken: string;
  previewToken: string;
};

export type StoredOptions = {
  enableTracking: boolean;
  signalsSandboxToken: string;
  signalsSandboxUrl: string;
  signalsApiKeys: { org: string; apiKey: string; apiKeyId: string }[];
  contentfulSpaces: ContentfulSpaceOption[];
  contentfulRules: string;
  contentfulFields: string;
  tunnelAddress: string;
};

const EMPTY_SPACE: ContentfulSpaceOption = {
  label: "",
  spaceId: "",
  environment: "master",
  deliveryToken: "",
  previewToken: "",
};

const DEFAULT_RULES_JSON = JSON.stringify(DEFAULT_RULES, null, 2);
const DEFAULT_FIELDS_LIST = DEFAULT_FIELDS.join(", ");

const SAMPLE_UUID = "00000000-0000-0000-0000-000000000000";
const UUID_PATTERN =
  "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$";
const UUID_DESCRIPTION = "Must be a valid UUID";

const Options = () => {
  const [options, setOptions] = useState<StoredOptions>({
    enableTracking: true,
    signalsSandboxToken: "",
    signalsSandboxUrl: "",
    signalsApiKeys: [],
    contentfulSpaces: [],
    contentfulRules: "",
    contentfulFields: "",
    tunnelAddress: "http://localhost:4040/",
  });
  const [status, setStatus] = useState("");

  useEffect(() => chrome.storage.sync.get(options, setOptions), []);

  useEffect(() => {
    const tid = setTimeout(() => setStatus(""), 1800);
    return () => clearTimeout(tid);
  }, [status]);

  const handler = (e: Event) => {
    e.preventDefault();
    if (
      e.currentTarget instanceof HTMLFormElement &&
      e.currentTarget.reportValidity()
    ) {
      const validated = {
        ...options,
        signalsApiKeys: options.signalsApiKeys.filter(
          ({ org, apiKey, apiKeyId }) => !!(org && apiKey && apiKeyId),
        ),
        contentfulSpaces: options.contentfulSpaces.filter(
          ({ spaceId, deliveryToken }) => !!(spaceId && deliveryToken),
        ),
      };
      chrome.storage.sync.set(validated, () => {
        setStatus("Preferences Saved");
      });
    }
  };

  return (
    <form
      onChange={({ target }) => {
        if (
          target instanceof HTMLTextAreaElement &&
          target.name === "contentfulRules"
        ) {
          target.setCustomValidity(validateRules(target.value) || "");
          const contentfulRules = target.value;
          setOptions((options) => ({ ...options, contentfulRules }));
        } else if (target instanceof HTMLInputElement) {
          const contentfulIndex = parseInt(
            target.dataset.contentfulIndex || "",
            10,
          );
          if (!Number.isNaN(contentfulIndex)) {
            setOptions((options) => {
              const space = {
                ...(options.contentfulSpaces[contentfulIndex] ?? EMPTY_SPACE),
                [target.name]: target.value,
              };
              const contentfulSpaces = [...options.contentfulSpaces];
              contentfulSpaces[contentfulIndex] = space;

              target.setCustomValidity(
                contentfulSpaces.find(
                  ({ spaceId, environment }, i) =>
                    i !== contentfulIndex &&
                    spaceId === space.spaceId &&
                    environment === space.environment,
                )
                  ? "Duplicate Contentful space/environment"
                  : "",
              );

              return { ...options, contentfulSpaces };
            });
            return;
          }

          const apiKeyIndex = parseInt(target.dataset.apiKeyIndex || "", 10);
          if (!Number.isNaN(apiKeyIndex)) {
            const info = options.signalsApiKeys[apiKeyIndex] ?? {
              org: "",
              apiKey: "",
              apiKeyId: "",
            };
            info[target.name as keyof typeof info] = target.value;
            const signalsApiKeys = [...options.signalsApiKeys];
            signalsApiKeys[apiKeyIndex] = info;

            if (
              signalsApiKeys.find(
                ({ org }, i) => i !== apiKeyIndex && org === info.org,
              )
            ) {
              target.setCustomValidity(
                "Duplicate API credentials for this organization",
              );
            } else {
              target.setCustomValidity("");
            }

            if (
              signalsApiKeys.find(
                ({ apiKeyId, org }, i) =>
                  i !== apiKeyIndex &&
                  apiKeyId === info.apiKeyId &&
                  org === info.org,
              )
            ) {
              target.setCustomValidity(
                "Duplicate API Key ID values found for this organization",
              );
            } else {
              target.setCustomValidity("");
            }

            setOptions((options) => ({
              ...options,
              signalsApiKeys,
            }));
          } else {
            setOptions((options) => ({
              ...options,
              [target.name]:
                target.type === "checkbox" ? target.checked : target.value,
            }));
          }
        }
      }}
      onSubmit={handler}
    >
      <h1>Snowplow Inspector Options</h1>
      <fieldset>
        <label>
          <input
            type="checkbox"
            name="enableTracking"
            checked={options.enableTracking}
          />
          Send anonymous usage information
        </label>

        <fieldset>
          <legend>Signals</legend>
          <p>
            For security reasons, only{" "}
            <abbr title="Machine to Machine">M2M</abbr>
            access tokens can access the attribute data stored in your Signals
            instance - <em>not</em> the access token provided when you log into
            Console. M2M tokens are obtained using API keys{" "}
            <a
              href="https://console.snowplowanalytics.com/credentials"
              target="_blank"
            >
              generated in Console
            </a>
            . Here you can define API keys to use for each Organization ID you
            want to access Attributes data for.
          </p>
          <p>
            <a href={utmify("https://snowplow.io/signals")} target="_blank">
              Find out more about Signals
            </a>
            , or{" "}
            <a
              href={utmify("https://docs.snowplow.io/docs/signals")}
              target="_blank"
            >
              view the documentation.
            </a>
          </p>
          <fieldset>
            <legend>API Keys</legend>
            <div>
              {options.signalsApiKeys.map(({ org, apiKey, apiKeyId }, i) => (
                <fieldset key={i}>
                  <label>
                    Organization ID
                    <input
                      type="text"
                      name="org"
                      data-api-key-index={i}
                      title={UUID_DESCRIPTION}
                      pattern={UUID_PATTERN}
                      placeholder={SAMPLE_UUID}
                      value={org}
                      required
                    />
                  </label>
                  {/^[0-9a-f-]{36}$/i.test(org) && !(apiKey && apiKeyId) ? (
                    <a
                      href={`https://console.snowplowanalytics.com/${org}/credentials`}
                      target="_blank"
                    >
                      Generate an API key pair
                    </a>
                  ) : null}
                  <label>
                    API Key ID
                    <input
                      type="text"
                      name="apiKeyId"
                      data-api-key-index={i}
                      title={UUID_DESCRIPTION}
                      pattern={UUID_PATTERN}
                      placeholder={SAMPLE_UUID}
                      value={apiKeyId}
                      required
                    />
                  </label>
                  <label>
                    API Key
                    <input
                      type="text"
                      name="apiKey"
                      data-api-key-index={i}
                      title={UUID_DESCRIPTION}
                      pattern={UUID_PATTERN}
                      placeholder={SAMPLE_UUID}
                      value={apiKey}
                      required
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      setOptions(({ signalsApiKeys, ...opts }) => ({
                        ...opts,
                        signalsApiKeys: signalsApiKeys.filter(
                          (_, index) => index !== i,
                        ),
                      }))
                    }
                  >
                    Remove organization
                  </button>
                </fieldset>
              ))}
            </div>
            <button
              type="button"
              onClick={() =>
                setOptions(({ signalsApiKeys, ...opts }) => ({
                  ...opts,
                  signalsApiKeys: signalsApiKeys.concat({
                    org: "",
                    apiKey: "",
                    apiKeyId: "",
                  }),
                }))
              }
            >
              Add new organization
            </button>
          </fieldset>
        </fieldset>
        <fieldset>
          <legend>Signals Sandbox</legend>
          <p>
            If you're{" "}
            <a href={utmify("https://try-signals.snowplow.io/")}>
              trialing Signals
            </a>
            , you can enter details of your sandbox environment here.
          </p>
          <label>
            Profiles API URL
            <input
              type="text"
              name="signalsSandboxUrl"
              title="Profiles API hostname only without path"
              pattern="(https?:\/\/)?[^\/:]+(:[0-9]+)?"
              placeholder="00000000-0000-0000-0000-000000000000.svc.snplow.net"
              value={options.signalsSandboxUrl}
            />
          </label>

          <label>
            Sandbox Token
            <input
              type="text"
              name="signalsSandboxToken"
              title={UUID_DESCRIPTION}
              pattern={UUID_PATTERN}
              placeholder={SAMPLE_UUID}
              value={options.signalsSandboxToken}
              required={!!options.signalsSandboxUrl}
            />
          </label>
        </fieldset>
        <fieldset>
          <legend>Contentful</legend>
          <p>
            Configure Contentful spaces to resolve content IDs found in event
            entities into linked entry titles in the event detail view. Delivery
            (and optional Preview) API tokens can be found in the Contentful web
            app under Settings &gt; API keys for each space. Leave this empty to
            disable Contentful resolution.
          </p>
          <fieldset>
            <legend>Spaces</legend>
            <div>
              {options.contentfulSpaces.map(
                (
                  { label, spaceId, environment, deliveryToken, previewToken },
                  i,
                ) => (
                  <fieldset key={i}>
                    <label>
                      Label
                      <input
                        type="text"
                        name="label"
                        data-contentful-index={i}
                        placeholder="Main"
                        value={label}
                      />
                    </label>
                    <label>
                      Space ID
                      <input
                        type="text"
                        name="spaceId"
                        data-contentful-index={i}
                        placeholder="p0qf7j048i0q"
                        value={spaceId}
                        required
                      />
                    </label>
                    <label>
                      Environment
                      <input
                        type="text"
                        name="environment"
                        data-contentful-index={i}
                        placeholder="master"
                        value={environment}
                      />
                    </label>
                    <label>
                      Delivery API token
                      <input
                        type="password"
                        name="deliveryToken"
                        data-contentful-index={i}
                        value={deliveryToken}
                        required
                      />
                    </label>
                    <label>
                      Preview API token (optional, resolves drafts)
                      <input
                        type="password"
                        name="previewToken"
                        data-contentful-index={i}
                        value={previewToken}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        setOptions(({ contentfulSpaces, ...opts }) => ({
                          ...opts,
                          contentfulSpaces: contentfulSpaces.filter(
                            (_, index) => index !== i,
                          ),
                        }))
                      }
                    >
                      Remove space
                    </button>
                  </fieldset>
                ),
              )}
            </div>
            <button
              type="button"
              onClick={() =>
                setOptions(({ contentfulSpaces, ...opts }) => ({
                  ...opts,
                  contentfulSpaces: contentfulSpaces.concat(EMPTY_SPACE),
                }))
              }
            >
              Add space
            </button>
          </fieldset>
          <fieldset>
            <legend>Detection rules (advanced)</legend>
            <p>
              JSON list of{" "}
              <code>
                {"{"} schema, paths, kind or discriminator {"}"}
              </code>{" "}
              rules describing where Contentful IDs appear in your entities.
              Leave empty to use the built-in defaults.
            </p>
            <label>
              Rules
              <textarea
                name="contentfulRules"
                rows={10}
                placeholder={DEFAULT_RULES_JSON}
                value={options.contentfulRules}
              />
            </label>
            <button
              type="button"
              onClick={() =>
                setOptions((options) => ({
                  ...options,
                  contentfulRules: DEFAULT_RULES_JSON,
                }))
              }
            >
              Reset to defaults
            </button>
          </fieldset>
          <fieldset>
            <legend>Extra fields</legend>
            <p>
              Comma-separated entry field names to show on the badge when the
              resolved entry has them, e.g. <code>slug, internalName</code>.
              Names may be written as Contentful labels (<code>Page key</code>)
              or as API ids (<code>pageKey</code>); the badge always reports the
              API id. Fields holding links, lists or rich text are skipped.
              Different content types carry different fields, so list every
              field you care about — absent ones are simply omitted. Leave empty
              to use the built-in defaults.
            </p>
            <label>
              Fields
              <input
                type="text"
                name="contentfulFields"
                placeholder={DEFAULT_FIELDS_LIST}
                value={options.contentfulFields}
              />
            </label>
          </fieldset>
        </fieldset>
        <label>
          Ngrok tunnel address
          <input
            type="text"
            name="tunnelAddress"
            value={options.tunnelAddress}
          />
        </label>
        {status ? <p class="status">{status}</p> : <button>Save</button>}
      </fieldset>
    </form>
  );
};

render(<Options />, document.body);
