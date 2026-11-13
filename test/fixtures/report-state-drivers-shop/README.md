# report-state-drivers-shop

A real Chromium capture of a small shop page whose head stylesheet restyles elements through other
controls' states. What the capture records as forced-state findings (owner → restyled element):

- `input.opt` `:checked` → `label.opt-label` (`.opt:checked + .opt-label`);
- `input.pick` `:checked` → `p.summary` (`color`) and `input.wrap` `:checked` → `p.summary`
  (`background`): two controls restyling different properties of one paragraph;
- the `button.btn` buttons' own `:hover` and `:focus`.

The stylesheet also has `.opt-label:hover`, but the capture records no state owned by the label (it
forces states on the controls), so this fixture does not exercise an element's own hover beside a
control's state; the synthetic and live Chromium cases do. `test/report-state-attribution-oracle.test.mjs`
checks that every state finding is attributed to the owner path the capture recorded.

- **State screenshots** byte-identical to the page's resting screenshot were removed; the report reads
  a missing state screenshot the same way.
- **The manifests carry no `compatibilityKey`.** The secret scanner reads that hex value as a possible
  API key, so it is not committed. The test copies the fixture and writes the same key into both
  manifests (`fixtureCompatibilityKey('report-state-drivers-shop')`).
