# shumi-cli — agent guide

The `shumi` CLI (npm package name: `shumi`, bin: `shumi`). ES modules, Node 20+.
Source in `src/`, entry `bin/shumi.js`. Tests: `yarn test` (vitest). Package
manager is **yarn** (`yarn.lock` committed; `yarn install --frozen-lockfile`).

## Releasing / bumping the CLI version

Publishing is automated via **GitHub Actions OIDC "Trusted Publishing"** — there
is **no `NPM_TOKEN` secret** and you should **never run `npm publish` locally**
(it won't be authenticated and would bypass the pipeline). A trusted publisher is
registered on npmjs.com for the `shumi` package (repo `mayrsascha/shumi-cli`,
workflow `publish.yml`).

To cut a release:

```bash
# 1. Bump "version" in package.json (semver). Example: 0.4.2 -> 0.4.3
# 2. Commit, tag (tag MUST equal the package.json version, prefixed with "v"),
#    and push the tag:
git commit -am "chore(release): shumi-cli 0.4.3"
git tag v0.4.3
git push --follow-tags
```

Pushing a `v*.*.*` tag triggers `.github/workflows/publish.yml`, which:
1. installs deps with yarn, runs the test suite,
2. **fails** if the tag doesn't match `package.json`'s `version` (guard step),
3. runs `npm publish` — npm authenticates to the registry via the GitHub OIDC
   id-token (no secret) and auto-attaches provenance.

Watch the run: `gh run watch <id> --exit-status` (or the Actions tab). Confirm
with `npm view shumi version`. If the run fails at the publish step, check that
the npm Trusted Publisher (npmjs.com → `shumi` package → Settings) still points
at repo `mayrsascha/shumi-cli` + workflow `publish.yml`.

Notes:
- Do **not** add or restore an `NPM_TOKEN` — OIDC replaces it. The old token was
  revoked.
- `npm version patch|minor|major` also works to do the bump+commit+tag in one
  step; just ensure the tag is pushed (`git push --follow-tags`).
