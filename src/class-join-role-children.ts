/** Positive expression positions only; unknown expressions never pass a role. */
import { childRole, type RoleTask } from './class-join-role-types.js';
import { splitTokens, type RoleToken } from './class-join-role-tokens.js';
import { callTasks, classListMethod, helperName, propertyParts } from './class-join-role-roots.js';
const binary = new Set([
  '===',
  '!==',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  'instanceof',
  '+',
  '-',
  '*',
  '/',
  '%',
  '**',
  '&',
  '|',
  '^',
  '<<',
  '>>',
  '>>>',
  'as',
  'satisfies',
]);
const assignments = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&&=', '||=', '??=', '=>', ',', ';']);
function ternary(nodes: RoleToken[]): { question: number; colon: number } | undefined {
  let question = -1,
    depth = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].text === '?') {
      if (question < 0) question = i;
      depth++;
    }
    if (nodes[i].text === ':' && --depth === 0 && question >= 0)
      return question > 0 && i > question + 1 && i < nodes.length - 1 ? { question, colon: i } : undefined;
  }
}
function logical(nodes: RoleToken[]): number {
  let and = -1,
    or = -1;
  nodes.forEach((n, i) => {
    if (n.text === '&&') and = i;
    if (n.text === '||' || n.text === '??') or = i;
  });
  return or >= 0 ? or : and;
}
export function expressionTasks(task: RoleTask): RoleTask[] | undefined {
  const { nodes, role, depth } = task;
  if (!role || nodes.some((n) => assignments.has(n.text))) return;
  const branch = ternary(nodes);
  if (branch)
    return [
      { nodes: nodes.slice(0, branch.question), depth: depth + 1 },
      {
        nodes: nodes.slice(branch.question + 1, branch.colon),
        depth: depth + 1,
        role: childRole(role, 'ternary-result', 'ternary:then'),
      },
      {
        nodes: nodes.slice(branch.colon + 1),
        depth: depth + 1,
        role: childRole(role, 'ternary-result', 'ternary:else'),
      },
    ];
  const join = logical(nodes);
  if (join >= 0)
    return [
      { nodes: nodes.slice(0, join), depth: depth + 1 },
      {
        nodes: nodes.slice(join + 1),
        depth: depth + 1,
        role: childRole(role, 'logical-result', `logical:${nodes[join].text}:rhs`),
      },
    ];
  if (nodes.some((n) => binary.has(n.text))) return;
  const only = nodes.length === 1 ? nodes[0] : undefined;
  if (only?.kind === 'group') return groupTasks(task, only);
  return positiveCall(task);
}
function groupTasks(task: RoleTask, node: RoleToken): RoleTask[] | undefined {
  const { role, depth } = task;
  if (node.text === '(') return [{ nodes: node.children!, role, depth: depth + 1 }];
  if (node.text === '[' && role!.containers)
    return splitTokens(node.children!).map((nodes, i) => ({
      nodes,
      depth: depth + 1,
      role: childRole(role!, 'array-element', `array:${i}`),
    }));
}
function positiveCall(task: RoleTask): RoleTask[] | undefined {
  const { nodes, depth } = task,
    call = nodes.at(-1);
  if (call?.kind !== 'group' || call.text !== '(') return;
  const methodIndex = nodes.length - 2,
    name = nodes[methodIndex]?.text;
  const helper = nodes.length === 2 && helperName(name);
  if (!helper && !classListMethod(nodes, methodIndex)) return;
  return callTasks(name, splitTokens(call.children!), depth, helper);
}
/** Object parsing stays at property boundaries, never treating predicates as keys. */
export function objectTasks(task: RoleTask): { keys: RoleToken[]; values: RoleTask[] } | undefined {
  const { nodes, role, depth } = task,
    object = nodes.length === 1 ? nodes[0] : undefined;
  if (object?.text !== '{' || !role?.containers) return;
  const keys: RoleToken[] = [],
    values: RoleTask[] = [];
  for (const part of splitTokens(object.children!)) {
    const property = propertyParts(part);
    if (property && property.key.kind !== 'group') {
      keys.push(property.key);
      values.push({ nodes: property.value, depth: depth + 1 });
    } else values.push({ nodes: part, depth: depth + 1 });
  }
  return { keys, values };
}
