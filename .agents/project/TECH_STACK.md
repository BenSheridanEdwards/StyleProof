# Tech stack

## Language and runtime

- **TypeScript** compiled with `tsc` to **ESM** (`"type": "module"`). Target
  `ES2022`, module `NodeNext`, `strict: true` (`tsconfig.json`).
- **Node.js** — `engines.node >= 18`; CI matrix builds on Node 18, 20, 22 and
  runs lint/format/privacy/audit/demo checks on 22.
- Library output is `dist/`; CLIs are plain `.mjs` in `bin/`.

## Runtime dependencies

- `pngjs` — PNG read/write for the report screenshots and crops.
- **Peer:** `@playwright/test` (`>=1.40`) — the browser engine the capture path
  drives. It is a peer dependency so adopters control the Playwright version.

## Dev tooling

- **ESLint 10** + **typescript-eslint** (`eslint.config.js`, flat config).
- **Prettier 3** (`.prettierrc.json`, `.prettierignore`).
- **Husky 9** git hooks (`.husky/`).
- **commitlint** + `@commitlint/config-conventional` (`commitlint.config.js`) on
  `commit-msg`.
- **Fallow** — complexity/dead-code/duplication gate (`.fallowrc.jsonc`,
  `.fallow/health-baseline.json`).
- **Playwright** — e2e specs (`playwright.config.ts`).

## Tests

- Unit: Node's built-in test runner (`node --test test/*.test.mjs`) against
  `dist/`.
- E2E: Playwright (`npm run test:e2e`).

## CI / automation (`.github/workflows/`)

- `ci.yml` — build/typecheck/lint/format/privacy/audit/demo/unit/e2e + CLI smoke.
- `secret-scan.yml` — gitleaks, full history, fail-closed.
- `codeql.yml` — CodeQL (javascript-typescript) on PR, push, and weekly.
- `pr-body.yml` — machine PR-body validation.
- `fallow.yml` — complexity/dead-code gate.
- `action-dogfood.yml` — runs the Action against generated fixtures.
- `release.yml`, `github-packages.yml` — publishing.

## Distribution

Published to npm as `styleproof` (MIT). The packed tarball ships `dist`, `bin`,
`docs/demo-composite.png`, `README.md`, `CHANGELOG.md`, `LICENSE`.
