# StyleProof-on-StyleProof dogfood

`demo-home.png` is the `example/demo` home surface declared by the root
`styleproof.config.ts` and captured by the advisory PR workflow.

The live path stamps `home@*` with matching
`productState { id: 'demo-home', revision: 'fixture-v1' }` — the only
certifying path. `example/styleproof.product-state.json` stays present but
empty (`{}`) so the declare-or-fail-closed gate remains armed for new
undeclared pairs. Matching `productState {id, revision}` is the only
certifying path; `legacyPairs` never certify.

This is a documentation screenshot of the committed demo fixture, not a
certification receipt.
