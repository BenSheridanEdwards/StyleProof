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
type TernaryArm = { from: number; question: number; arm: number; nesting: number };
function appendArm(task: RoleTask, tasks: RoleTask[], state: TernaryArm, colon: number): void {
  tasks.push({ nodes: task.nodes.slice(state.from, state.question), depth: task.depth + 1 });
  tasks.push({
    nodes: task.nodes.slice(state.question + 1, colon),
    depth: task.depth + 1,
    role: childRole(task.role!, 'ternary-result', state.arm === 0 ? 'ternary:then' : `ternary:else:${state.arm}:then`),
  });
  state.from = colon + 1;
  state.arm++;
}
function scanArm(task: RoleTask, tasks: RoleTask[], state: TernaryArm, index: number): boolean {
  const text = task.nodes[index].text;
  if (text === '?') {
    if (state.nesting === 0) state.question = index;
    state.nesting++;
    return true;
  }
  if (text !== ':') return true;
  if (state.nesting === 0) return false;
  if (--state.nesting !== 0) return true;
  if (state.question <= state.from || index <= state.question + 1 || index >= task.nodes.length - 1) return false;
  appendArm(task, tasks, state, index);
  return true;
}
/** Flatten only alternate chains; actual nested result expressions keep their depth. */
function ternary(task: RoleTask): RoleTask[] | undefined {
  const { nodes, role, depth } = task;
  const tasks: RoleTask[] = [];
  const state: TernaryArm = { from: 0, question: -1, arm: 0, nesting: 0 };
  for (let i = 0; i < nodes.length; i++) if (!scanArm(task, tasks, state, i)) return;
  if (!state.arm || state.nesting !== 0) return;
  tasks.push({
    nodes: nodes.slice(state.from),
    depth: depth + 1,
    role: childRole(role!, 'ternary-result', state.arm === 1 ? 'ternary:else' : `ternary:else:${state.arm - 1}`),
  });
  return tasks;
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
  const branch = ternary(task);
  if (branch) return branch;
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
