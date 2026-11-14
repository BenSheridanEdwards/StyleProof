import type * as TS from 'typescript';
import type { SourceSpan } from './script-reach.js';

type Unit = {
  key: string;
  kind: string;
  status: string;
  change?: string;
  side?: string;
  sourceKey?: string;
  range?: SourceSpan;
  condition?: string;
  consumer?: string;
  referrer?: string;
};
type Evidence = {
  scenarios: Record<string, string[]>;
  sources: Record<string, Record<string, string>>;
  execution: Record<string, Record<string, Record<string, Record<string, string>>>>;
  ledger: Record<string, Record<string, string[]>>;
};
type Ctx = {
  ts: typeof TS;
  root: TS.SourceFile;
  nodes: TS.Node[];
  surfaces: string[];
  anchors: (surface: string, kind: string) => string;
};
type Found = {
  condition: string | null;
  guard: { kind: string; path: string[]; reason: string; armRanOn?: string[] | null };
  enclosingSurfaces: string[];
  enclosing?: { function: string; at: string };
};

const at = (c: Ctx, n: TS.Node) =>
  `${c.root.fileName}:${c.root.getLineAndCharacterOfPosition(n.getStart(c.root)).line + 1}`;
const enclosing = (c: Ctx, n: TS.Node): TS.FunctionLikeDeclaration | undefined => {
  for (let p = n.parent; p; p = p.parent)
    if (c.ts.isFunctionLike(p) && 'body' in p) return p as TS.FunctionLikeDeclaration;
};
const inside = (c: Ctx, n: TS.Node, anchor: string) => {
  const [line, columns] = anchor.split(':');
  if (!columns) return false;
  const offset = c.root.getPositionOfLineAndCharacter(Number(line) - 1, Number(columns.split('-')[0]));
  return offset >= n.getStart(c.root) && offset < n.end;
};
const ran = (c: Ctx, n: TS.Node, kinds = ['executed', 'mixed']) =>
  c.surfaces.filter((s) =>
    kinds.some((kind) =>
      c
        .anchors(s, kind)
        .split(' ')
        .some((a) => inside(c, n, a)),
    ),
  );
const references = (c: Ctx, name: string, declaration: TS.Node) =>
  c.nodes.filter(
    (n) =>
      c.ts.isIdentifier(n) &&
      n.text === name &&
      n !== declaration &&
      !(c.ts.isPropertyAccessExpression(n.parent) && n.parent.name === n),
  );

function cssSites(c: Ctx, unit: Unit, used: string) {
  const { ts } = c;
  const tokens = [...(unit.consumer ?? unit.key).matchAll(/\.([\w-]+)/g)]
    .map((m) => m[1])
    .filter((token) => ![...used.matchAll(/\.([\w-]+)/g)].some((m) => m[1] === token));
  return c.nodes.filter(
    (n) =>
      (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateTail(n) || ts.isTemplateMiddle(n)) &&
      tokens.some((token) => n.text.split(/\s+/).includes(token)),
  );
}

function bindingSites(c: Ctx, site: TS.Node): TS.Node[] {
  const { ts, root } = c;
  for (let p: TS.Node | undefined = site; p && !ts.isFunctionLike(p); p = p.parent) {
    if (
      ts.isPropertyAssignment(p) &&
      ts.isObjectLiteralExpression(p.parent) &&
      ts.isVariableDeclaration(p.parent.parent)
    ) {
      const [binding, prop] = [p.parent.parent.name.getText(root), p.name.getText(root)];
      return c.nodes.filter(
        (n) =>
          ts.isPropertyAccessExpression(n) && n.expression.getText(root) === binding && n.name.getText(root) === prop,
      );
    }
    if (ts.isVariableDeclaration(p) && p.initializer && p.parent.flags & ts.NodeFlags.Const)
      return references(c, p.name.getText(root), p.name);
  }
  return [site];
}

function jsSites(c: Ctx, range: SourceSpan, text: string) {
  const { ts, root } = c;
  let start = root.getPositionOfLineAndCharacter(range.start.line - 1, range.start.column);
  while (/\s/.test(text[start] ?? '')) start++;
  const end = root.getPositionOfLineAndCharacter(range.end.line - 1, range.end.column);
  const site = c.nodes.filter((n) => n.getStart(root) <= start && n.end >= end).at(-1) ?? root;
  return bindingSites(c, ts.isVariableStatement(site) ? site.declarationList.declarations[0] : site);
}

/** The guard when `n` is one arm of its parent: the arm node itself and its condition. */
function armOf(c: Ctx, n: TS.Node, p: TS.Node) {
  const { ts, root } = c;
  if (ts.isConditionalExpression(p) && n !== p.condition)
    return { kind: 'branch', arm: n, condition: p.condition.getText(root), negated: n === p.whenFalse };
  if (ts.isBinaryExpression(p) && n === p.right && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    return { kind: 'branch', arm: n, condition: p.left.getText(root), negated: false };
}

function callSites(c: Ctx, name: string) {
  const { ts, root } = c;
  return c.nodes.filter(
    (n) =>
      (ts.isCallExpression(n) &&
        (n.expression.getText(root) === name ||
          (n.expression.getText(root) === 'h' && n.arguments[0]?.getText(root) === name))) ||
      ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(root) === name),
  );
}

function walk(c: Ctx, site: TS.Node, path: string[], depth: number): Found {
  const fn = enclosing(c, site);
  const route = [...path, at(c, site)];
  for (let n = site; n.parent && n.parent !== fn; n = n.parent) {
    const found = armOf(c, n, n.parent);
    if (found)
      return {
        condition: `${at(c, n.parent)} ${found.negated ? `!(${found.condition})` : found.condition}`,
        guard: {
          kind: found.kind,
          path: route,
          armRanOn: ran(c, found.arm, ['executed']),
          reason: 'Execution anchors within the guarded arm',
        },
        enclosingSurfaces: ran(c, fn?.body ?? fn ?? c.root),
        ...(fn && { enclosing: { function: fn.name?.getText(c.root) ?? '<anonymous>', at: at(c, fn) } }),
      };
  }
  const paths =
    fn?.name && depth < 4 ? callSites(c, fn.name.getText(c.root)).map((call) => walk(c, call, route, depth + 1)) : [];
  if (paths.length) return paths.find((p) => p.condition) ?? paths[0];
  const reason = `Unguarded use ${route.join(' → ')} ran on ${ran(c, site).join(', ')}`;
  return {
    condition: null,
    guard: { kind: 'none', path: route, armRanOn: null, reason },
    enclosingSurfaces: ran(c, site),
  };
}

function deriveOne(unit: Unit, evidence: Evidence, surfaces: string[], ts: typeof TS | null) {
  const side = unit.side ?? (unit.change === 'removed' ? 'base' : 'head');
  const ledgerSurfaces = (key: string) => surfaces.filter((s) => evidence.ledger[side]?.[s]?.includes(key));
  const simple = (kind: string, condition: string | null, enclosingSurfaces: string[], reason: string) => ({
    ...unit,
    guardingCondition: condition,
    enclosingSurfaces,
    guard: { kind, reason, armRanOn: null },
  });
  if (unit.condition)
    return simple(
      'media',
      unit.condition,
      ledgerSurfaces(unit.key.slice(unit.condition.length + 3)),
      'Inner selector usage',
    );
  if (unit.status === 'blind-channel')
    return simple(
      'channel',
      `blind-channel ${unit.key} via ${unit.referrer}`,
      ledgerSurfaces(unit.referrer ?? ''),
      'Computed styles cannot measure this channel',
    );
  if (!ts) return simple('unmeasured', null, [], 'A typescript parser is required');
  const file = unit.sourceKey ?? Object.keys(evidence.sources[side] ?? {})[0];
  const text = evidence.sources[side]?.[file];
  if (!text) return simple('unmeasured', null, [], 'Source is unavailable');
  const root = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const nodes: TS.Node[] = [];
  const visit = (n: TS.Node) => {
    nodes.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  const anchors = (s: string, kind: string) => evidence.execution[side]?.[s]?.[file]?.[kind] ?? '';
  const c: Ctx = { ts, root, nodes, surfaces, anchors };
  const used = surfaces.flatMap((s) => evidence.ledger[side]?.[s] ?? []).join(' ');
  const sites = unit.kind === 'css' ? cssSites(c, unit, used) : unit.range ? jsSites(c, unit.range, text) : [];
  const paths = sites.sort((a, b) => a.getStart(root) - b.getStart(root)).map((site) => walk(c, site, [], 0));
  const found = paths.find((p) => p.condition) ?? paths[0];
  if (!found) return simple('none', null, [], 'No supported source use found');
  const { condition, ...details } = found;
  return { ...unit, guardingCondition: condition, ...details };
}

/** Structure selects the guard; captured anchors only describe where its function and arm ran. */
export function deriveReachGuards(units: Unit[], evidence: Evidence, ts: typeof TS | null) {
  const surfaces = [...new Set(Object.values(evidence.scenarios).flat())];
  return units.map((unit) => deriveOne(unit, evidence, surfaces, ts));
}
