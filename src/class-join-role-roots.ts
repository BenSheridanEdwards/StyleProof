/** Recognise only exact class roots; everything else keeps no positive role. */
import { classWords, type ClassSource } from './class-join-source.js';
import { tokenSpan, type RoleToken } from './class-join-role-tokens.js';
import type { PositiveRole, RoleTask } from './class-join-role-types.js';
const rootSeparators = new Set(['=', ':']);
const helpers = new Set(['clsx', 'cx', 'classnames', 'classNames', 'cva', 'twMerge', 'twJoin', 'cn']);
export const helperName = (name: string): boolean => helpers.has(name);
export function propertyName(token: RoleToken | undefined, source: ClassSource): string | undefined {
  if (token?.kind === 'word') return token.text;
  if (token?.kind !== 'literal' || token.text === '`') return;
  const words = classWords(source, [{ start: token.start + 1, end: token.end - 1 }]);
  return words.length === 1 ? words[0].token : undefined;
}
export function classListMethod(nodes: RoleToken[], index: number): boolean {
  return nodes[index - 1]?.text === '.' && nodes[index - 2]?.text === 'classList' && nodes[index - 3]?.text === '.';
}
export function classMember(nodes: RoleToken[], index: number): boolean {
  return nodes[index]?.text === 'className' && nodes[index - 1]?.text === '.' && nodes[index - 2]?.text !== 'dataset';
}
export const valueRole = (name: string): PositiveRole => ({
  kind: 'class-value',
  slot: 'class-value',
  containers: name === 'class' || name === 'classList',
});
export function classAttribute(node: RoleToken): boolean {
  return !!node.attribute;
}
export function valueEnd(nodes: RoleToken[], start: number): number {
  let end = start;
  while (end < nodes.length && nodes[end].text !== ',' && nodes[end].text !== ';') end++;
  return end;
}
export function rootValue(source: ClassSource, nodes: RoleToken[], index: number, object: boolean) {
  if (!rootSeparators.has(nodes[index + 1]?.text)) return;
  const node = nodes[index],
    name = propertyName(node, source);
  if (!name || !['class', 'className', 'classList'].includes(name)) return;
  const attribute = nodes[index + 1]?.text === '=' && classAttribute(node);
  const assignment = nodes[index + 1]?.text === '=' && classMember(nodes, index);
  const property = object && nodes[index + 1]?.text === ':' && (index === 0 || nodes[index - 1].text === ',');
  if (!attribute && !assignment && !property) return;
  const first = nodes[index + 2];
  if (!first) return;
  const end = attribute ? index + 3 : valueEnd(nodes, index + 2);
  const values = attribute && first.text === '{' ? first.children! : nodes.slice(index + 2, end);
  return { values, end, role: valueRole(name), attribute, span: tokenSpan(nodes.slice(index, end)) };
}
/** A return annotation can occur in an object method; property values stay runtime. */
export function typeGroup(nodes: RoleToken[], index: number, object: boolean, annotation: boolean): boolean {
  if (nodes[index].text !== '{') return false;
  const previous = nodes[index - 1]?.text;
  if (['extends', 'as', 'satisfies'].includes(previous)) return true;
  if (previous !== ':' || !annotation) return false;
  const target = nodes[index - 2];
  if (target?.kind === 'group' && target.text === '(') return true;
  return (
    !object && (target?.kind === 'word' || target?.kind === 'group' || target?.text === '?' || target?.text === '!')
  );
}
export function objectGroup(nodes: RoleToken[], index: number, parent: string): boolean {
  if (nodes[index].text !== '{') return false;
  const previous = nodes[index - 1]?.text;
  return previous === undefined
    ? parent === '(' || parent === '['
    : ['=', ':', ',', 'return', '?', '||', '&&', '??'].includes(previous);
}
export function propertyParts(nodes: RoleToken[]) {
  const colon = nodes.findIndex((n) => n.text === ':');
  return colon === 1 ? { key: nodes[0], value: nodes.slice(2) } : undefined;
}
export function callTasks(name: string, args: RoleToken[][], depth: number, helper: boolean): RoleTask[] {
  return args.map((nodes, i) => ({
    nodes,
    depth: depth + 1,
    ...(helper && name === 'cva' && i > 0
      ? { config: 'options' as const }
      : helper || name === 'add' || (name === 'replace' && i === 1)
        ? { role: { kind: 'helper-argument', slot: `argument:${i}`, containers: helper } }
        : {}),
  }));
}
