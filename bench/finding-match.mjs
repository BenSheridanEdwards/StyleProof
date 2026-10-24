// How a bench decides a finding landed where a seeded change was made. Shared by
// the detection corpus and the reach corpus so both score findings the same way.

/** `.sp-cta` → `sp-cta`: the marker class a fixture puts on each target. */
export const markerOf = (sel) => sel.replace(/^\./, '');

/** A finding lands on the target when its class attribute carries the marker. */
export const onTarget = (f, marker) => (f.cls ?? '').split(/\s+/).includes(marker);

/** With `props`, at least one changed property must be one of them or one of their longhands. */
export const hasProp = (f, props) =>
  !props?.length || (f.props ?? []).some((p) => props.some((want) => p.prop === want || p.prop.startsWith(`${want}-`)));
