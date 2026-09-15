# StyleProof-on-StyleProof dogfood

`demo-home.png` is the `example/demo` home surface declared by the root
`styleproof.config.ts` and captured by the advisory PR workflow.

The live path arms declare-or-fail-closed:
`example/styleproof.product-state.json` records `home` as known-legacy.
Undeclared pairs fail closed; declared `home@*` pairs stay advisory
and do not certify.

This is a documentation screenshot of the committed demo fixture, not a
certification receipt.
