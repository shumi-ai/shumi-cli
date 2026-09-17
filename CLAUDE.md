# shumi-cli — agent guide

The `shumi` CLI (npm package name: `shumi`, bin: `shumi`). ES modules, Node 20+.
Source in `src/`, entry `bin/shumi.js`. Tests: `yarn test` (vitest). Package
manager is **yarn** (`yarn.lock` committed; `yarn install --frozen-lockfile`).

## Priorities

The north star and the bets in flight live in one page: `pxeodev/docs/strategy/current.mdx`. Nothing here copies it. When planning, prioritizing, or triaging, fetch it fresh:

    gh api repos/pxeodev/docs/contents/strategy/current.mdx -H 'Accept: application/vnd.github.raw'

Every PR and issue carries one label: `bet:<slug>` for a bet on that page, or `ktlo` for keep-the-lights-on (the page holds the closed list). Work that fits neither is not started — it needs a PR against that page first. Strategy changes are PRs to that page, merged only when both founders agree in the thread; never merge there yourself.

## Releasing / bumping the CLI version

Publishing is automated via **GitHub Actions OIDC "Trusted Publishing"** — there
is **no `NPM_TOKEN` secret** and you should **never run `npm publish` locally**
(it won't be authenticated and would bypass the pipeline). A trusted publisher is
registered on npmjs.com for the `shumi` package (repo `shumi-ai/shumi-cli`,
workflow `publish.yml`).

To cut a release:

```bash
# 1. Bump "version" in package.json (semver). Example: 0.4.2 -> 0.4.3
# 2. Commit, tag (tag MUST equal the package.json version, prefixed with "v"),
#    and push the tag:
git commit -am "chore(release): shumi-cli 0.4.3"
git tag v0.4.3
git push origin main
git push origin v0.4.3          # push the tag explicitly, see below
```

**Push the tag by name, not with `--follow-tags`.** `--follow-tags` carries only
*annotated* tags, and `git tag v0.4.3` creates a lightweight one, so the commit
goes up, the tag silently stays local, and nothing publishes. Git reports success
either way. Verify before you walk away:

```bash
git ls-remote --tags origin | grep v0.4.3   # no output = nothing will publish
```

This bit 0.7.4, which was released following these steps as written.

Pushing a `v*.*.*` tag triggers `.github/workflows/publish.yml`, which:
1. installs deps with yarn, runs the test suite,
2. **fails** if the tag doesn't match `package.json`'s `version` (guard step),
3. runs `npm publish` — npm authenticates to the registry via the GitHub OIDC
   id-token (no secret) and auto-attaches provenance.

Watch the run: `gh run watch <id> --exit-status` (or the Actions tab). Confirm
with `npm view shumi version`. If the run fails at the publish step, check that
the npm Trusted Publisher (npmjs.com → `shumi` package → Settings) still points
at repo `shumi-ai/shumi-cli` + workflow `publish.yml`.

Notes:
- Do **not** add or restore an `NPM_TOKEN` — OIDC replaces it. The old token was
  revoked.
- `npm version patch|minor|major` also works to do the bump+commit+tag in one
  step, and it annotates the tag, so `git push --follow-tags` does carry it.
  That is the one path where `--follow-tags` is safe. Confirm with
  `git ls-remote --tags origin` regardless.


## PR review & landing: done from the coinrotator repo

There is no CI reviewer. Review and land PRs in **this** repo from a Claude Code session opened in a local clone of `mayrsascha/coinrotator`, where the skills and the enforcing guard live:

- `/review-pr <n> --repo <this owner/repo>`: fresh-context review on your own Claude plan. It posts or updates one PR comment with the findings, stamped with the reviewed commit.
- `/land <owner/repo>#<n>`: refuses to land without a clean verdict for the current head, and runs `/review-pr` first if one is missing. No `--auto`, and no GitHub merge button.
- `/triage`: review and prioritize open PRs across all repos.

Full process: pxeodev/docs `ops/pr-review-and-landing.mdx`.
