# Maintaining this fork

This repository is Understood's fork of
[`snowplow/chrome-snowplow-inspector`](https://github.com/snowplow/chrome-snowplow-inspector).
This document is fork-specific and lives only in our fork — it is intentionally **not** part of
`README.adoc` (which merges from upstream), so it never causes merge conflicts.

## Remotes

The fork uses the standard two-remote layout:

| Remote     | Points to                                     | Role              |
| ---------- | --------------------------------------------- | ----------------- |
| `origin`   | `understood/chrome-snowplow-inspector`        | Our fork          |
| `upstream` | `snowplow/chrome-snowplow-inspector`          | The original repo |

If `upstream` is ever missing (`git remote -v` to check), add it:

```bash
git remote add upstream git@github.com:snowplow/chrome-snowplow-inspector.git
```

## Syncing changes from upstream

Pulling in new upstream releases is a routine three-step flow. Use **`merge`, not `rebase`**, on
`main` — `main` is shared (it lives on `origin` and teammates pull it), and rebasing rewrites
shared history. Rebase is fine only on your own personal feature branches.

```bash
git fetch upstream
git checkout main
git merge upstream/main        # resolve any conflicts (see below)
npm install                    # regenerate the lockfile if it conflicted
npm test && npm run prepare    # verify: typecheck + jest + prettier, then build
git push origin main
```

### Resolving conflicts

Most merges are clean because our customizations live in **new files** (see below). Conflicts,
when they happen, fall into two buckets:

- **`package-lock.json`** — never hand-edit it. Take either side and regenerate:

  ```bash
  git checkout --theirs package-lock.json   # or --ours
  npm install                               # rewrites the lockfile correctly
  git add package-lock.json
  ```

- **Shared source files we've edited** — resolve normally. The files carrying our edits today
  (keep this list current as the fork evolves):
  - `src/options.tsx`
  - `src/components/Debugger/EventPayload/index.tsx`
  - `src/components/SnowplowInspector.tsx`
  - `README.adoc`

## Keeping merges painless

Prefer adding customizations as **new files** rather than editing upstream files — new files
never conflict. The Contentful resolver is the model for this: nearly all of it lives in a
self-contained `src/ts/contentful/` directory and dedicated components, touching only a handful
of shared files.

## Dependency / security updates

`npm audit` counts the entire dependency tree, including build- and test-only tooling that never
ships in the extension, and rates severity theoretically. Triage before acting: what actually
matters is what gets bundled into `dist/` (runtime deps), not dev tooling.

- Prefer **`npm audit fix`** (semver-compatible, non-breaking). Verify with
  `npm test && npm run prepare`, then commit the updated `package-lock.json`.
- **Avoid `npm audit fix --force`** — it applies major-version bumps and breaking changes.
  Do major upgrades deliberately, one at a time, with tests.

Note: dependency bumps we make in the fork will conflict on `package-lock.json` when merging
upstream. That's expected — resolve it by regenerating the lockfile as described above.
