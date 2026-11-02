# Setup server contract

`styleproof setup` generates a dedicated Playwright configuration that must either start a production server or point at one managed outside StyleProof. Setup validates that choice before installing dependencies, installing Chromium, or scaffolding files. `--dry-run` performs the same read-only validation.

StyleProof infers these production server commands:

- Next.js: an optional `build` script followed by `start`, or `next start` when no start script exists.
- Vite: an optional `build` script followed by `vite preview`.
- Other projects: an optional `build` script followed by `start`, or a `preview` script.

If none applies, setup exits with an actionable error instead of generating an `npm run build && npm run start` command for scripts that do not exist.

Use an explicit command when the application has a different production path:

```bash
styleproof setup --server-command "npm run build:web && npm run serve:web"
```

The command is written to the generated TypeScript configuration as JSON string data and is not executed during setup. Playwright runs it later when capture starts.

When another process or platform owns the application server, omit Playwright's `webServer` block:

```bash
styleproof setup --external-server --base-url https://preview.example.test
```

The URL must be reachable when capture runs. `--server-command` and `--external-server` are mutually exclusive. Pass the same choice when invoking `styleproof-init --check` or `styleproof-init --upgrade` directly so validation and refreshed workflow metadata match the generated setup.

## Merge-base comparison

The report Action's `comparison-base` input accepts exactly `pull-request-base`
(default) or `merge-base`. Omitted/default behavior is unchanged: the expected
baseline is the trusted PR base tip B and no comparison API request is made.
Unknown values fail before comparison or publication.

If your producer intentionally compares the fork point A against captured head H,
add the following inputs to your report Action step, using a reviewed Action ref
that contains this feature:

```yaml
with:
  baseline-dir: __stylemaps__/base
  fresh-dir: __stylemaps__/fresh
  comparison-base: merge-base
```

This input selects verification policy only. It does not change generated capture
workflows, fetch history, check out commits, or relabel captures. Before opting in:

1. Resolve full lowercase 40-hex B/H from the trusted PR event in the base
   repository. Use its base and head commits, not mutable branch names, today's
   target tip, or a checkout's synthetic PR merge commit.
2. In the producer, request
   `GET /repos/{owner}/{repo}/compare/{B}...{H}?page=1&per_page=1` using that exact
   immutable tuple. Require `base_commit.sha === B` and a full lowercase
   `merge_base_commit.sha`. That returned SHA is A; the paginated commit list is
   not a source of identity. Both producer and verifier need `contents: read` for
   private repositories. Preserve the report job's other existing permissions.
3. Actually check out and capture A and H, truthfully recording each SHA in its
   manifest. Both sides still need compatible capture settings and product-state
   identity when required. Existing B captures do not become A captures by
   changing the input or manifest.
4. The report Action independently repeats this lookup from trusted context. Its
   single selected A/H tuple feeds diff, report and receipt validation. It never
   accepts an artifact's claimed policy, repository, PR number or historical SHA.

GitHub supports immutable comparisons across repositories in the same repository
network, including forks. A fork's maps still come from untrusted code: correct
source binding does not authenticate their contents, and clean fork results still
require the existing maintainer approval flow. Certification failures remain
unapprovable. No additional write permissions or approval-policy changes are
needed for merge-base resolution.

For `workflow_run`, H remains the captured `workflow_run.head_sha`, not today's
PR head. The Action keeps its existing exact-head PR association rules. If a later
association reflects changed target history, independently recomputed A can
disagree with an older capture. That run fails closed; recapture against an agreed
immutable tuple rather than trusting artifact-provided historical context. The
association lookup's existing first-page limitation can also prevent resolution;
this feature does not add pagination to that lookup.

GitHub's comparison response defines the verifier's canonical merge base. A local
`git merge-base` producer must agree with that exact result. Histories with
multiple best ancestors can yield different choices in Git and GitHub. Use the
same immutable GitHub comparison during production and verification, and refuse
certification if agreement cannot be established. Never select whichever ancestor
matches an uploaded manifest.

API rejection, inaccessible or unrelated history, mismatched returned base, and
missing or malformed merge-base identity all stop the Action before it emits a
partial context tuple. There is no fallback to B, a mutable ref or an artifact's
claimed A. Existing source-binding, report-publication and approval guards remain
unchanged.

GitHub API contract: [Compare two commits](https://docs.github.com/rest/commits/commits#compare-two-commits).
