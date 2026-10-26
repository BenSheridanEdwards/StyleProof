# anti-slop (vendored)

Opinionated Oxlint rules from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop).
Upstream says to vendor them: there is no official npm package. Do not install
an npm package with a similar name, such as `oxlint-plugin-anti-slop`.

## Source

- Repository: https://github.com/dmmulroy/anti-slop
- Commit: `13909c9e07590f5a85d93c62712259fe14a883f7`
- Mapping: upstream `src/<path>` → `vendor/anti-slop/<path>`, minus `src/effect/`
  (the Effect plugin; StyleProof does not use Effect) and the `*.test.ts` files.
  Upstream's root `LICENSE` (MIT) → `vendor/anti-slop/LICENSE`.
  `vendor/eslint-stylistic/` keeps its own `LICENSE` and `UPSTREAM.md`.
- Every copied file is byte-identical to that commit. No local changes.
- This README and the two manifests are StyleProof metadata, not upstream files.

## Hash check

`UPSTREAM.sha256` lists the SHA-256 of every vendored file. The files arrive
over several PRs, and a large file can arrive in line-range parts, so
`UPSTREAM.prefixes` lists the SHA-256 of each allowed first-N-lines prefix.

`npm run check:anti-slop-vendor` (also a unit test, so CI runs it) fails on an
unlisted file, a symlink, or a file whose bytes match neither its whole-file
hash nor a declared prefix. Before `.oxlintrc.json` exists, missing files and
declared prefixes are allowed. Once it exists (the wiring PR), every listed
file must be present and whole.

To check against upstream directly:

```sh
upstream_dir=$(mktemp -d)
git clone https://github.com/dmmulroy/anti-slop "$upstream_dir"
git -C "$upstream_dir" checkout 13909c9e07590f5a85d93c62712259fe14a883f7
diff -r -x '*.test.ts' -x effect -x LICENSE -x README.md -x UPSTREAM.sha256 -x UPSTREAM.prefixes \
  "$upstream_dir/src" vendor/anti-slop
```

## Updating

Get a Security review of the new commit first. Copy the approved files by
hand, unmodified, in a reviewed PR; regenerate both manifests; record the new
commit here. Do not run upstream's `npx skills add` installer or its
`install.mjs --force`: both pull or overwrite code that nobody reviewed.

Oxlint and ESLint both skip this folder. It still gets code review, because
Oxlint runs it with Node's full permissions.
