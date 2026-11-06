/** Erased TypeScript positions inherit one mode across every nested token group. */
import { objectGroup } from './class-join-role-roots.js';
import type { RoleToken } from './class-join-role-tokens.js';
type Frame = { nodes: RoleToken[]; parent: string; object: boolean; member?: boolean };
type Mode = { kind: 'annotation' | 'assertion' | 'alias' | 'interface' | 'heritage'; operand: boolean; body?: boolean };
type Cursor = {
  mode?: Mode;
  alias?: boolean;
  declaration?: boolean;
  binding?: boolean;
  conditionals: number;
  classHeader?: boolean;
};
const declarations = new Set(['let', 'const', 'var', 'using']);
const typePrefixes = new Set(['as', 'satisfies']);
const typeSyntax = /[:<]|\b(?:as|satisfies|type|interface|implements)\b/;
const statementWords = new Set(['function', 'class', 'interface', 'type', 'export', 'import', 'return', 'throw']);
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
function angleEnds(nodes: RoleToken[]): Map<number, number> {
  const ends = new Map<number, number>(),
    stack: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.text === '<') stack.push(i);
    else if (/^>{1,3}$/.test(node.text)) {
      for (let j = 0; j < node.text.length && stack.length; j++) ends.set(stack.pop()!, i);
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
  if (annotation(frame, state, index)) {
    const target = frame.nodes[index - 1];
    state.mode = { kind: 'annotation', operand: true, body: target?.text === '(' };
  } else if (!frame.object && frame.nodes[index + 1]?.text === '{') frame.nodes[index + 1].runtimeBlock = true;
}
function declarationStep(frame: Frame, state: Cursor, index: number): void {
  const node = frame.nodes[index],
    text = node.text;
  if (declarations.has(text)) {
    state.declaration = true;
    state.binding = true;
  }
  if (text === 'class' && frame.nodes[index + 1]?.kind === 'word') state.classHeader = true;
  if (text === 'type' && !frame.object && frame.nodes[index + 1]?.kind === 'word') state.alias = true;
  if (text === 'interface' && frame.nodes[index + 1]?.kind === 'word')
    state.mode = { kind: 'interface', operand: true };
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
  const node = frame.nodes[index],
    previous = frame.nodes[index - 1];
  if (!/[\n\r\u2028\u2029]/.test(text.slice(previous.end, node.start))) return;
  const statement =
    declarations.has(node.text) ||
    statementWords.has(node.text) ||
    (node.kind === 'word' && ['.', '=', '('].includes(frame.nodes[index + 1]?.text));
  if (!statement) return;
  state.mode = undefined;
  state.binding = false;
  state.declaration = false;
}
/** A body follows a completed return/heritage type; an object type starts an operand. */
function typeStep(state: Cursor, node: RoleToken, previous?: RoleToken): boolean {
  const mode = state.mode!;
  if (
    ['=', ',', ';'].includes(node.text) ||
    (node.text === '=>' && mode.body && previous?.text !== '(') ||
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
  return {
    nodes: node.children!,
    parent: node.text,
    member,
    object: !node.runtimeBlock && objectGroup(frame.nodes, index, frame.parent),
  };
}
function markFrame(frame: Frame, pending: Frame[], text: string): void {
  const state: Cursor = { conditionals: 0 },
    angles = angleEnds(frame.nodes);
  for (let i = 0; i < frame.nodes.length; i++) {
    const node = frame.nodes[i],
      end = angles.get(i);
    statementBoundary(frame, state, i, text);
    if (end !== undefined) {
      for (let j = i; j <= end; j++) frame.nodes[j].typeOnly = true;
      if (state.mode) state.mode.operand = false;
      i = end;
      continue;
    }
    if (state.mode && typeStep(state, node, frame.nodes[i - 1])) continue;
    runtimeStep(frame, state, i);
    if (node.children) pending.push(childFrame(frame, state, i));
  }
}
export function markTypeScopes(nodes: RoleToken[], text: string): void {
  if (!nodes.length || !typeSyntax.test(text.slice(nodes[0].start, nodes.at(-1)!.end))) return;
  const pending: Frame[] = [{ nodes, parent: '', object: false }];
  while (pending.length) markFrame(pending.pop()!, pending, text);
}
