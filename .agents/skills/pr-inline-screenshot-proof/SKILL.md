---
name: pr-inline-screenshot-proof
description: Use when opening or updating a GitHub pull request that needs screenshots, videos, or proof artifacts rendered inline in the PR description instead of shown as plain links.
---

# PR Inline Screenshot Proof

This skill exists for one job: make proof visible inside the pull request body.
Links alone are not proof. Local paths are not proof. A reviewer must be able to
open the PR and see the evidence where the template asks for it.

## Required Pattern

1. Capture screenshots from the real changed branch or runtime.
2. Save proof files in the repo, normally under `docs/proof/<short-scope>/`.
3. Commit the proof files on the PR branch.
4. Push the branch before writing or updating the PR body.
5. Embed screenshots with Markdown image syntax:

   ```md
   ![Descriptive alt text](https://github.com/OWNER/REPO/blob/BRANCH/docs/proof/SCOPE/file.png?raw=1)
   ```

Use `?raw=1` on GitHub blob URLs so the image renders reliably in the PR
description. Videos may be linked as committed artifacts, but screenshot proof
must use `![alt](url)` image embeds.

## Hard Failures

- A bare screenshot URL in the PR body.
- A local path such as `/Users/.../screenshot.png`.
- A screenshot stored outside the branch being reviewed.
- A stale screenshot from mock data, a stale dev server, or the wrong repo.
- A PR body that says proof exists but does not contain `![`.

## Verification

After creating or editing the PR, run:

```sh
gh pr view <number> --json body --jq .body
```

Confirm the proof section contains inline image Markdown. If the change has no
rendered or behavioural proof surface, write `Not applicable` in the proof
section with the technical reason.
