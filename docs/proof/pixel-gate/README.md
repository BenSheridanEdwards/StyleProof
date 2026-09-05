# Proof: the opt-in pixel gate catches a change computed styles cannot see

Two one-shot captures (`styleproof-capture <url> --key product --widths 1024`) of a
product card. The head swaps the bytes of the `<img class="hero">` from a solid green
1×1 PNG to a solid red one. Every computed style is identical on both sides, so the
computed-style gate is green. The pixel gate compares the screenshots the capture
already wrote and attributes the changed region to the elements under it.

## Without `--pixels` (unchanged behaviour)

```
$ styleproof-diff base head --allow-unasserted
⚠ UNVERIFIED DIAGNOSTIC: 0 reviewable computed-style changes across 1 paired capture(s); content/structure not evaluated
exit 0
```

## With `--pixels`

```
$ styleproof-diff base head --allow-unasserted --pixels --json diff.json
🖼 pixel gate: 4 changed region(s) in 1 surface(s)
  product@1024 [rest]: 296×128 at 40,72 (34537 px) — body > div:nth-child(1) > img:nth-child(2)  (.hero), body > div:nth-child(1)  (.card)
  product@1024 [hover]: 296×128 at 40,72 (34537 px) — body > div:nth-child(1) > img:nth-child(2)  (.hero), body > div:nth-child(1)  (.card)
  product@1024 [focus]: 296×128 at 40,72 (34537 px) — body > div:nth-child(1) > img:nth-child(2)  (.hero), body > div:nth-child(1)  (.card)
  product@1024 [active]: 296×128 at 40,72 (34537 px) — body > div:nth-child(1) > img:nth-child(2)  (.hero), body > div:nth-child(1)  (.card)
✗ 0 DOM change(s), 0 computed-style difference(s), 0 state-delta difference(s) across 0 surfaces + pixel gate: 4 changed region(s)
exit 1
```

`diff.json` → `pixels.surfaces[0].layers[0].comparison.regions[0]`:

```json
{
  "rect": [40, 72, 296, 128],
  "changedPixels": 34537,
  "elements": [
    { "path": "body > div:nth-child(1) > img:nth-child(2)", "cls": "hero" },
    { "path": "body > div:nth-child(1)", "cls": "card" }
  ]
}
```

`composite.png` is the rest-layer screenshot of both sides, cropped to the attributed
region with padding, with the region outlined in magenta. Before is on the left.
