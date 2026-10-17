# Two-directory report with an undeclared product-state pair

Both images render `report.html` from the same steps on `example/demo`, run
from the repository root, where `styleproof.config.json` arms the legacy-pair
ledger (`example/styleproof.product-state.json`, empty):

1. Serve a copy of `example/demo/index.html` and run `styleproof-capture <url> --out base`.
2. Change the `body` colour from `rgb(214, 228, 232)` to `rgb(200, 228, 232)`.
3. Run `styleproof-capture <url> --out head`.
4. Run `styleproof-report base head --out report` (no `--legacy-pairs`, no `--expected-*-sha`).

- `before-main.png`: origin/main. "No reviewable computed-style changes", 0 crops.
- `after-branch.png`: this branch. The `body` change `#d6e4e8 → #c8e4e8` and its
  crop, under the same non-certifying product-state banner. Exit code 1 on both.
