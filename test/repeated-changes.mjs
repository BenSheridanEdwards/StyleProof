function changeFragments(clause) {
  const out = [];
  const pattern = /([^,;]*?) from ([^,;]+?) to ([^,;]+?)(?=, | while | and |; | when |\.(?:\s|$)|$)/g;
  for (const m of clause.matchAll(pattern)) {
    let prop = m[1].trim();
    prop = / changes?$/.test(prop) ? prop.replace(/ changes?$/, '') : prop.replace(/^.*\bchanges? (?:also )?/, '');
    prop = prop.replace(/^(?:and |while |also )+/, '').replace(/^the /, '');
    const words = prop.split(' ');
    out.push(`${words.slice(-3).join(' ')} from ${m[2].trim()} to ${m[3].trim()}`);
  }
  return out;
}
/**
 * One change said twice inside one clause: a fragment repeated within one owner's group, or two
 * owner groups of a counted clause ("one changes X, while the other changes X") that state the
 * same changes, so the contrast is not there (QA16-01). Different owners with overlapping changes
 * ("one changes X and Y, while the other changes X") each state their own.
 */
export function repeatedChanges(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!/\bwhen\b/i.test(line)) continue;
    for (const clause of line.split(/\b[Ww]hen\b/)) {
      const groups = clause
        .split(/, while |; /)
        .map(changeFragments)
        .filter((g) => g.length);
      const inGroup = groups.flatMap((g) => g.filter((f, i) => g.indexOf(f) !== i));
      const sets = groups.map((g) => [...new Set(g)].sort().join(' | '));
      const sameGroups = sets.find((set, i) => sets.indexOf(set) !== i);
      const twice = inGroup[0] ?? sameGroups;
      if (twice) out.push(`one change said twice in one clause ("${twice}"): "${line.trim().slice(0, 140)}"`);
    }
  }
  return out;
}
