/** Erased TypeScript positions inherit one mode across every nested token group. */
import { objectGroup } from './class-join-role-roots.js';
import type { RoleToken } from './class-join-role-tokens.js';
type Frame = { nodes: RoleToken[]; parent: string; object: boolean; member?: boolean };
type Mode = {
  kind: 'annotation' | 'assertion' | 'alias' | 'interface' | 'heritage';
  operand: boolean;
  body?: boolean;
  arrowReturn?: boolean;
};
type Cursor = {
  mode?: Mode;
  alias?: boolean;
  declaration?: boolean;
  binding?: boolean;
  conditionals: number;
  classHeader?: boolean;
  functionHeader?: boolean;
  genericDeclaration?: boolean;
  caseLabel?: boolean;
};
const declarations = new Set(['let', 'const', 'var', 'using']);
const typePrefixes = new Set(['as', 'satisfies']);
const typeSyntax = /[:<]|\b(?:as|satisfies|type|interface|implements)\b/;
const statementWords = new Set([
  'function',
  'class',
  'interface',
  'type',
  'export',
  'import',
  'return',
  'throw',
  'try',
  'do',
  'async',
  'await',
  'if',
  'for',
  'while',
  'switch',
  'new',
  'this',
]);
const declarationStarters = new Set(['abstract', 'declare', 'enum', 'namespace']);
const angleStops = new Set([
  ';',
  '&&',
  '||',
  '??',
  '==',
  '===',
  '!=',
  '!==',
  '+',
  '-',
  '*',
  '/',
  '%',
  '**',
  'return',
  'function',
  'class',
  'export',
]);
const arrowStops = new Set([';', ',', '=']);
function runtimeStart(nodes: RoleToken[], index: number): boolean {
  const node = nodes[index];
  return (
    node.text === '{' ||
    declarations.has(node.text) ||
    statementWords.has(node.text) ||
    (declarationStarters.has(node.text) && nodes[index + 1]?.kind === 'word') ||
    (node.kind === 'word' && ['.', '=', '(', '!', '[', '?.', ':'].includes(nodes[index + 1]?.text))
  );
}
function newline(nodes: RoleToken[], index: number, text: string): boolean {
  return index > 0 && /[\n\r\u2028\u2029]/.test(text.slice(nodes[index - 1].end, nodes[index].start));
}
function parameterAngles(nodes: RoleToken[], index: number): boolean {
  const previous = nodes[index - 1]?.text;
  return (
    previous === undefined ||
    (['=', ':', '(', '=>'].includes(previous) && nodes[index - 1]?.kind !== 'group') ||
    ['function', 'class', 'interface', 'type'].includes(nodes[index - 2]?.text)
  );
}
function angleBoundary(nodes: RoleToken[], index: number, text: string, open: number): boolean {
  const node = nodes[index],
    previous = nodes[index - 1]?.text;
  if (angleStops.has(node.text)) return true;
  if (declarations.has(node.text) && !(parameterAngles(nodes, open) && ['<', ','].includes(previous))) return true;
  if (node.text === ',' && nodes[index + 1]?.kind === 'word' && ['=', ':'].includes(nodes[index + 2]?.text))
    return !parameterAngles(nodes, open);
  return (
    newline(nodes, index, text) &&
    runtimeStart(nodes, index) &&
    !typeOperators.has(previous) &&
    !['<', ',', '.'].includes(previous)
  );
}
/** A reverse pass avoids rescanning the remainder for each function-type arrow. */
function functionArrows(nodes: RoleToken[]): Set<number> {
  const result = new Set<number>();
  let later = false;
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (arrowStops.has(nodes[i].text)) later = false;
    if (nodes[i].text !== '=>') continue;
    if (later) result.add(i);
    later = true;
  }
  return result;
}
const typeOperators = new Set([
  '|',
  '&',
  '?',
  ':',
  '=>',
  'extends',
  'keyof',
  'typeof',
  'readonly',
  'infer',
  'unique',
  'is',
  'asserts',
]);
/** Balance angles once per sibling sequence; ambiguous balanced groups stay conservative. */
function angleEnds(nodes: RoleToken[], text: string): Map<number, number> {
  const ends = new Map<number, number>(),
    stack: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (stack.length && angleBoundary(nodes, i, text, stack.at(-1)!)) stack.length = 0;
    if (node.text === '<') stack.push(i);
    else if (/^>{1,3}=?$/.test(node.text)) {
      const count = node.text.replace('=', '').length;
      for (let j = 0; j < count && stack.length; j++) ends.set(stack.pop()!, i);
    } else if (
      node.attribute &&
      nodes[i + 1]?.text === '=' &&
      ['class', 'className', 'classList'].includes(node.text)
    ) {
      stack.length = 0;
    }
  }
  return ends;
}
/** Rebuild once after type-mode classification; runtime comparisons are never split. */
function normalizedAngles(nodes: RoleToken[], closers: Map<number, RoleToken>): void {
  if (!closers.size) return;
  const expanded = nodes.flatMap((node, index) => (closers.has(index) ? [closers.get(index)!, node] : node));
  nodes.length = 0;
  for (const node of expanded) nodes.push(node);
}
function annotation(frame: Frame, state: Cursor, index: number): boolean {
  const nodes = frame.nodes,
    target = nodes[index - 1];
  if (target?.kind === 'group' && target.text === '(') return true;
  if (frame.object || state.conditionals) return false;
  return frame.parent === '(' || !!state.binding || !!frame.member;
}
function colon(frame: Frame, state: Cursor, index: number): void {
  if (state.conditionals) {
    state.conditionals--;
    return;
  }
  if (state.caseLabel) {
    state.caseLabel = false;
    if (frame.nodes[index + 1]?.text === '{') frame.nodes[index + 1].runtimeBlock = true;
    return;
  }
  if (annotation(frame, state, index)) {
    const target = frame.nodes[index - 1];
    const before = frame.nodes[index - 2];
    state.mode = {
      kind: 'annotation',
      operand: true,
      body: target?.text === '(',
      arrowReturn:
        !state.functionHeader && !state.genericDeclaration && (before?.kind !== 'word' || before.text === 'async'),
    };
  } else if (!frame.object && frame.nodes[index + 1]?.text === '{') frame.nodes[index + 1].runtimeBlock = true;
}
function declarationMode(frame: Frame, state: Cursor, index: number): void {
  const text = frame.nodes[index].text;
  if (text === 'function') state.functionHeader = true;
  if (!frame.object && (text === 'case' || (text === 'default' && frame.nodes[index + 1]?.text === ':')))
    state.caseLabel = true;
  if (text === 'class' && frame.nodes[index + 1]?.kind === 'word') state.classHeader = true;
  if (text === 'type' && !frame.object && frame.nodes[index + 1]?.kind === 'word') state.alias = true;
  if (text === 'interface' && frame.nodes[index + 1]?.kind === 'word')
    state.mode = { kind: 'interface', operand: true };
}
function declarationStep(frame: Frame, state: Cursor, index: number): void {
  const text = frame.nodes[index].text;
  if (declarations.has(text)) {
    state.declaration = true;
    state.binding = true;
    state.functionHeader = false;
    state.genericDeclaration = false;
  }
  declarationMode(frame, state, index);
  if (text === '=') {
    state.binding = false;
    if (state.alias) {
      state.mode = { kind: 'alias', operand: true };
      state.alias = false;
    }
  }
  if (text === ',') state.binding = state.declaration;
  if (text === ';') {
    state.declaration = false;
    state.binding = false;
    state.alias = false;
    state.functionHeader = false;
    state.genericDeclaration = false;
  }
}
function runtimeStep(frame: Frame, state: Cursor, index: number): void {
  const text = frame.nodes[index].text;
  declarationStep(frame, state, index);
  if (text === 'implements' && state.classHeader) state.mode = { kind: 'heritage', operand: true, body: true };
  if (
    typePrefixes.has(text) &&
    frame.nodes[index + 1]?.text !== ':' &&
    !['.', '?.'].includes(frame.nodes[index - 1]?.text)
  )
    state.mode = { kind: 'assertion', operand: true };
  if (text === '?' && frame.nodes[index + 1]?.text !== ':') state.conditionals++;
  if (text === ':') colon(frame, state, index);
}
/** Preserve ASI runtime statements after a completed type, without ending type continuations. */
function statementBoundary(frame: Frame, state: Cursor, index: number, text: string): void {
  if (!state.mode || state.mode.operand || index === 0) return;
  if (!newline(frame.nodes, index, text) || !runtimeStart(frame.nodes, index)) return;
  state.mode = undefined;
  state.binding = false;
  state.declaration = false;
}
/** A body follows a completed return/heritage type; an object type starts an operand. */
function typeStep(state: Cursor, node: RoleToken, previous: RoleToken | undefined, laterArrow: boolean): boolean {
  const mode = state.mode!;
  if (
    ['=', ',', ';'].includes(node.text) ||
    (node.text === '=>' && mode.body && (previous?.text !== '(' || (mode.arrowReturn && !laterArrow))) ||
    (node.text === '{' && mode.body && !mode.operand)
  ) {
    state.mode = undefined;
    return false;
  }
  node.typeOnly = true;
  mode.operand = typeOperators.has(node.text);
  if (node.text === '{' && mode.kind === 'interface') state.mode = undefined;
  return true;
}
function childFrame(frame: Frame, state: Cursor, index: number): Frame {
  const node = frame.nodes[index];
  const member = node.text === '{' && state.classHeader;
  if (node.text === '{') state.classHeader = false;
  if (node.text === '{') {
    state.functionHeader = false;
    state.genericDeclaration = false;
  }
  return {
    nodes: node.children!,
    parent: node.text,
    member,
    object: !node.runtimeBlock && objectGroup(frame.nodes, index, frame.parent),
  };
}
function markAngles(frame: Frame, state: Cursor, index: number, end: number): void {
  state.genericDeclaration =
    frame.nodes[index - 1]?.kind === 'word' && (frame.object || !!frame.member || !!state.functionHeader);
  for (let j = index; j <= end; j++) frame.nodes[j].typeOnly = true;
  if (state.mode) state.mode.operand = false;
}
/** A compact close needs a type root, rather than an arbitrary earlier less-than. */
function typeAngle(frame: Frame, state: Cursor, index: number): boolean {
  return (
    !!state.mode ||
    !!state.alias ||
    !!state.functionHeader ||
    !!state.classHeader ||
    parameterAngles(frame.nodes, index)
  );
}
function visitAngle(frame: Frame, state: Cursor, index: number, end: number, closers: Map<number, RoleToken>): boolean {
  const closer = frame.nodes[end],
    compact = closer.text.endsWith('=');
  if (compact && !typeAngle(frame, state, index)) return false;
  markAngles(frame, state, index, end);
  if (compact) {
    closers.set(end, { ...closer, text: closer.text.slice(0, -1), end: closer.end - 1 });
    Object.assign(closer, { text: '=', start: closer.end - 1, typeOnly: false });
    if (state.mode) typeStep(state, closer, undefined, false);
    runtimeStep(frame, state, end);
  }
  return true;
}
function markFrame(frame: Frame, pending: Frame[], text: string): void {
  const state: Cursor = { conditionals: 0 },
    angles = angleEnds(frame.nodes, text),
    closers = new Map<number, RoleToken>(),
    arrows = functionArrows(frame.nodes);
  for (let i = 0; i < frame.nodes.length; i++) {
    const node = frame.nodes[i],
      end = angles.get(i);
    statementBoundary(frame, state, i, text);
    if (end !== undefined && visitAngle(frame, state, i, end, closers)) {
      i = end;
      continue;
    }
    if (state.mode && typeStep(state, node, frame.nodes[i - 1], arrows.has(i))) continue;
    runtimeStep(frame, state, i);
    if (node.children) pending.push(childFrame(frame, state, i));
  }
  normalizedAngles(frame.nodes, closers);
}
export function markTypeScopes(nodes: RoleToken[], text: string): void {
  if (!nodes.length || !typeSyntax.test(text.slice(nodes[0].start, nodes.at(-1)!.end))) return;
  const pending: Frame[] = [{ nodes, parent: '', object: false }];
  while (pending.length) markFrame(pending.pop()!, pending, text);
}
