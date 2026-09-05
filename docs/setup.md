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
