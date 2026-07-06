# selective-remap fixture

A tiny React-ish source tree (three pages — `home`, `pricing`, `dashboard` — over
shared and colocated components) used by `test/selective-remap-recipe.test.mjs` to
prove the full opt-in selective-remap pipeline end to end:

```
git diff --name-only  →  dependency-cruiser graph  →  affectedSurfaces()  →
capture only the returned subset, reuse committed base maps for the rest
```

## `graph.depcruise.json` is a real dependency-cruiser run

The library takes the module graph as an **input** and adds no runtime dependency,
so the test consumes a committed, pre-generated dependency-cruiser graph rather than
shelling out to `depcruise` (which is not a project dependency). It was generated
from this fixture with:

```sh
cd test/fixtures/selective-remap
npx dependency-cruiser@16 --config .dependency-cruiser.json \
  --output-type json "src/**/*.{ts,tsx,css}" > out.json
```

then reduced to `{ modules: [{ source, dependencies: [{ resolved, dynamic }] }] }`
(source modules only, `node_modules` dropped, deduped, sorted) — the exact shape the
README recipe maps dependency-cruiser output into. The `.dependency-cruiser.json` /
`tsconfig.json` here are the config used, kept so the graph is reproducible. The
recipe test maps it into `ModuleEdge[]` exactly as the README shows.

Everything here is generic (`home`/`pricing`/`dashboard`, `Header`/`Hero`/`Chart`/
`PriceTable`) — no real project shapes.
