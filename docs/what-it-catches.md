# What StyleProof catches — and its honest boundary

StyleProof's promise on a PR: **every visible change is surfaced.** This page states
exactly what that means — what it catches, and, just as important, where the boundary
is — so the confidence you place in a green check is earned, not assumed.

These claims are executable. [`test/pr-surfacing.e2e.spec.ts`](../test/pr-surfacing.e2e.spec.ts)
is a dogfood that runs the real capture → diff → report flow for each change class below
and fails if any one stops being surfaced.

## What it catches (proven end to end)

On every **captured surface**, base vs head:

| Change                                                       | Surfaced as                         | Pinned by      |
| ------------------------------------------------------------ | ----------------------------------- | -------------- |
| A computed style differs (resting)                           | `style` finding, property named     | pr-surfacing ✓ |
| A `:hover` / `:focus` / `:active` variant dropped or changed | `state` finding                     | pr-surfacing ✓ |
| A `::before` / `::after` style differs                       | `style` finding, pseudo tagged      | pr-surfacing ✓ |
| An element is added or removed                               | `dom` finding (added / removed)     | pr-surfacing ✓ |
| An element is retagged (`button` → `a`)                      | removed + added at that position    | pr-surfacing ✓ |
| A nav item / route disappears                                | inventory guard, named, **gates**   | pr-surfacing ✓ |
| A surface exists on only one side                            | reported as a new / removed surface | pr-surfacing ✓ |
| Nothing changed                                              | zero findings (no false positives)  | pr-surfacing ✓ |

The reachable set is kept complete by two guards that run _before_ the diff:

- **Crawl** — captures every route linked from the nav root, so you don't hand-list them.
- **Coverage guard (`expected`)** — fails your own test suite if a route in your app's
  registry wasn't captured, AND (3.9.0) travels with the bundle as a coverage ledger so
  the **gate** states a green's completeness basis: `styleproof-diff` blocks when a
  registered surface wasn't captured (even on an empty diff) and prints `✓ coverage
complete`, `✗ coverage INCOMPLETE`, or `⚠ completeness NOT asserted` (no registry). A
  green stops silently implying a completeness it can't back up.
- **Determinism (3.10.0)** — the ledger also records how the capture's determinism was
  established (`self-checked` / `replayed` / `unproven`), and the gate blocks a green
  from an `unproven` capture — because a clean diff of two nondeterministic reads could
  just be luck. A green now certifies both _"I looked everywhere"_ and _"my look was
  stable."_

## The boundary (stated plainly)

StyleProof surfaces 100% of the change classes above **on the surfaces it captures**. It
cannot diff a surface it never reached. The honest gaps, and how to close each:

| Blind spot                                                                    | Why                                                   | Close it with                                                                       |
| ----------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| A route not linked from the crawl root (`/admin`, a page behind a menu click) | the crawl reads the nav; it doesn't guess URLs        | list it in `surfaces`, or point `expected` at it so the coverage guard fails loudly |
| A state never triggered (a width-specific menu, a transient toast)            | only `:hover/:focus/:active` are forced automatically | model it as an explicit `variant` / `liveState`                                     |
| Shadow DOM / same-origin iframe internals                                     | not traversed                                         | capture emits a one-time warning naming the host; certify it separately             |
| Nondeterministic content (embeds, timestamps)                                 | auto-excluded as a live region so it can't flake      | `ignore` selectors to scope it out deliberately                                     |

The design principle: **the captured set should equal the reachable set, and the guards
fail you when it doesn't.** A green StyleProof check means _"every change on every captured
surface is surfaced, and the coverage guard agrees the captured set is complete"_ — not
_"the app has no other surfaces in the universe."_ Keep `expected` honest and the crawl
rooted where your nav is, and the two statements converge.
