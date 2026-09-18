# Consumer pin-bump checklist

Use this when a consuming repository (or its Visual / StyleProof CI job) needs a
newer StyleProof **Action** and **package** than its current pins. Keep Action and
package aligned: bumping only one is how classify-time and capture-time drift
apart.

This checklist is generic. It does not name private consumer repos or internal
paths.

## Dual-bump rule

Bump **both** together in the same consumer change:

1. **Package** — the `styleproof` npm dependency (or lockfile entry) your capture /
   CLI path uses.
2. **Action** — the `uses:` pin for the StyleProof GitHub Action (report /
   `workflow_run` classify path).

If only the package moves, capture may honor tip features while the Action still
ignores them at classify time. If only the Action moves, classify may expect
evidence the older package never wrote.

Do not soft-pass a Visual / StyleProof failure to “get past” a pin skew. Fix the
pins (or restore a known-good pair) first.

## SHA pin vs `@v7`

| Target | When to use |
| --- | --- |
| **Commit SHA** (full or unambiguous short SHA of StyleProof `main`) | Prefer while the published major tag (`@v7`) **lags tip**. Example tip at time of writing: `3fd7d089`. |
| **`@v7` / `styleproof@^7`** | Prefer **after** a release moves `@v7` (and the npm major) onto that tip. |

Practical rule:

- If `npm view styleproof version` / the Action’s `@v7` still resolves to an older
  commit than the tip you need (for example tip `3fd7d089` while `@v7` still
  points at an earlier SHA such as `e8291d19`), **pin the tip SHA** for both
  Action and package until a release lands.
- After that release, you may switch both pins to `@v7` / `^7` together.

Never leave Action on `@v7` and package on a tip SHA (or the reverse) for a
production Visual path.

## `workflow_run` consumers: main-first Action bump

Consumers that run StyleProof classify on a trusted **`workflow_run`** job
(often the Visual / report job) load the Action from **the default branch of the
consumer**, not from the feature PR branch.

For those layouts:

1. Land (or merge) the **Action pin bump on the consumer’s `main` first**.
2. Then open or rebase the long-lived feature / dogfood PR that needs tip
   behavior.

Otherwise Visual keeps using the old Action from `main` while the feature branch
only bumps the package — dual-bump on the feature PR alone does not fix
classify.

Pull-request-only (same-run) Action layouts still need the dual-bump rule, but
they do not require the main-first step.

## Checklist

Copy into the consumer PR description:

- [ ] StyleProof **package** pin updated to tip SHA _or_ to `@v7`/`^7` after release
- [ ] StyleProof **Action** `uses:` pin updated to the **same** tip SHA _or_ `@v7`
- [ ] Pins match (no Action/package skew)
- [ ] If the classify job is `workflow_run`: Action bump is on **consumer `main`**
      (or already merged there) before relying on tip classify behavior
- [ ] Local / CI smoke: capture + compare (or Visual) against the new pins
- [ ] No soft-pass of pin-skew / CERTIFICATION_FAILED caused by stale Action

## Out of scope here

- Executing a specific consumer’s bump (owned by that repo)
- Claiming StyleProof mapping / Phase proof is complete
- Soft-passing Visual or StyleProof checks

## See also

- [Upgrading to 7.0.0](../README.md#upgrading-to-700) in the README
- [docs/REFERENCE.md](REFERENCE.md) for Action inputs and workflow shapes
