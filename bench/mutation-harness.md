# Mutation harness

A local dev tool that scores StyleProof's detection against known edits to a
real app. It is not a CI gate. Use it to measure a change to the capture or
diff logic in minutes, then compare the numbers across StyleProof versions.

The [detection corpus](detection-corpus.json) measures single CSS rules on one
fixture page. The mutation harness measures the same capture → diff path on a
real app's source, with its real cascade, layout, and noise.

## Run

```sh
npm run bench:mutate -- bench/mutation-targets/demo.json   # score every mutation
npm run bench:mutate -- path/to/target.json --only color-btn-bg,text-modal-title
npm run bench:mutate -- --history                          # compare logged runs
```

Flags: `--only id,id` runs a subset, `--log <file>` changes the log
(default `.styleproof/mutation-runs.jsonl`), `--keep-workdir` keeps the
working copy for inspection.

## What one run does

1. Copies the target `root` to a temp working copy. The target is read-only:
   the harness writes only to the copy, refuses a mutation file that resolves
   outside it, and fails the run if any mutated file in the target changed.
2. Serves the copy (`serve.static`, or the app's own `serve.command`).
3. Captures every page × width twice. The two baselines must diff to zero,
   else the run stops and names the noisy elements (add `ignore` selectors).
4. For each mutation: apply the edit → capture → diff against the baseline
   (style, state, DOM, and the advisory content layer) → score → revert.
5. Prints the scores and appends one JSON line to the log, with the
   StyleProof version, commit, and dirty flag, and the target's commit.

## Scores

| Score               | Meaning                                                                               |
| ------------------- | ------------------------------------------------------------------------------------- |
| detected            | A finding lands on an `expect.selector` element (or inside it) with an expected prop. |
| precision           | Expected findings ÷ all findings for the mutation.                                    |
| detection rate      | Detected mutations ÷ mutations that expect a detection.                               |
| false-positive rate | Mutations with any stray finding ÷ all mutations.                                     |
| runtime             | Wall time per mutation: edit, settle, capture all surfaces, diff, revert.             |

A mutation passes (`✓`) when it is detected with zero stray findings, or, for
`expect.clean`, when it has zero findings.

## Target config

Keep configs for private apps outside this repo, or under the gitignored
`.styleproof/` directory. Paths are relative to the config file.

```jsonc
{
  "name": "my-app",
  "root": "../my-app", // the external app; never modified
  "serve": { "static": "dist" }, // or the app's dev server:
  // "serve": { "command": "npx vite --port {port} --strictPort", "url": "http://127.0.0.1:{port}", "settleMs": 1000 },
  "prepare": "npm run build", // optional, runs once in the working copy
  "copy": { "exclude": [".git", "node_modules"], "link": ["node_modules"] }, // defaults
  "pages": [{ "key": "home", "path": "/" }],
  "widths": [1280],
  "ignore": [".clock"], // nondeterministic regions
  "mutations": [
    {
      "id": "cta-red",
      "category": "color",
      "file": "src/button.css",
      "find": "background: #2563eb;", // must occur exactly once
      "replace": "background: #dc2626;",
      "expect": { "selector": ".cta", "props": ["background-color"], "allow": [] },
    },
    {
      "id": "hex-equivalent",
      "file": "src/button.css",
      "find": "#ffffff",
      "replace": "#fff",
      "expect": { "clean": true },
    },
  ],
}
```

- `expect.props` matches a prop or its longhands (`border` matches `border-top-color`).
  Omit it for text changes.
- `expect.allow` lists selectors whose findings are expected collateral, such
  as a sibling that a layout shift moves. They count as expected, not stray.
- `serve.settleMs` is the wait after each edit and revert, so a dev server can
  rebuild. Static serving reads from disk on each request and needs none.
- `copy.link` entries are symlinks into the target. A tool that writes into
  one (for example, a bundler cache inside `node_modules`) writes into the
  target. Point that cache elsewhere, or drop the link and install in `prepare`.
