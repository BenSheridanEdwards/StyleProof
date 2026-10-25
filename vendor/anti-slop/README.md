# anti-slop (vendored)

Opinionated Oxlint rules from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop).
Upstream says to vendor them: there is no official npm package. Do not install
an npm package with a similar name, such as `oxlint-plugin-anti-slop`.

## Source

- Repository: https://github.com/dmmulroy/anti-slop
- Commit: `13909c9e07590f5a85d93c62712259fe14a883f7`
- Copied: `src/` minus `src/effect/` (the Effect plugin; StyleProof does not use
  Effect) and minus the `*.test.ts` files. `LICENSE` (MIT) is upstream's root
  licence. `vendor/eslint-stylistic/` keeps its own `LICENSE` and `UPSTREAM.md`.
- Every copied file is byte-identical to that commit. No local changes yet.
- The files import `@oxlint/plugins`, pinned at exactly the `oxlint` version.

## Checking a copy

```sh
git clone https://github.com/dmmulroy/anti-slop /tmp/anti-slop
git -C /tmp/anti-slop checkout 13909c9e07590f5a85d93c62712259fe14a883f7
diff -r -x '*.test.ts' -x effect -x LICENSE -x README.md /tmp/anti-slop/src vendor/anti-slop
```

## Updating

Change these files by hand, in a reviewed PR. Do not run upstream's
`npx skills add` installer or its `install.mjs --force`: both pull or overwrite
code that nobody reviewed. Record the new commit and any local changes here.

Oxlint and ESLint both skip this folder. It still gets code review, because
Oxlint runs it with Node's full permissions.
