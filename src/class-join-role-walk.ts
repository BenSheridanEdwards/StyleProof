/** Bounded work stack for positive values, opaque expressions and cva data. */
import { roleTokens, splitTokens, tokenSpan, ROLE_DEPTH, type RoleToken } from './class-join-role-tokens.js';
import { expressionTasks, objectTasks } from './class-join-role-children.js';
import { propertyName, propertyParts } from './class-join-role-roots.js';
import { childRole, type ClassRoles, type PositiveRole, type RoleTask } from './class-join-role-types.js';
import type { ClassSource, Part } from './class-join-source.js';
export type RoleReader = { source: ClassSource; result: ClassRoles; limit?: number };
export function depthGap(reader: RoleReader, start: number): void {
  reader.limit = Math.min(reader.limit ?? start, start);
  reader.result.contexts.push({
    start,
    end: reader.source.text.length,
    extractionGap: true,
    residual: 'class role nesting depth limit (128) exceeded',
  });
}
function record(reader: RoleReader, node: RoleToken, role?: PositiveRole, excluded = false, key = false): void {
  if (node.kind !== 'literal' && !key) return;
  const escaped =
    node.text === '`' &&
    !!node.literal?.substitutions.length &&
    node.literal.parts.some((p) => reader.source.text.slice(p.start, p.end).includes('\\'));
  reader.result.states.set(node.start, {
    context: true,
    ...(role ? { role: `${role.kind}:${role.slot}` } : {}),
    ...(key && node.kind === 'word' ? { bareEnd: node.end } : {}),
    ...(excluded ? { excluded: true } : {}),
    ...(escaped ? { escapedTemplate: true } : {}),
  });
}
function templateTasks(reader: RoleReader, node: RoleToken, task: RoleTask): RoleTask[] {
  return (node.literal?.substitutions ?? []).map((part, i) => {
    const nodes = readRolePart(reader, part);
    return {
      nodes,
      depth: task.depth + 1,
      config: task.config,
      ...(part.whole && task.role ? { role: childRole(task.role, 'template-value', `template:${i}`) } : {}),
    };
  });
}
function opaqueTasks(reader: RoleReader, task: RoleTask): RoleTask[] {
  const result: RoleTask[] = [];
  for (let i = 0; i < task.nodes.length; i++) {
    const node = task.nodes[i],
      key = (i === 0 || task.nodes[i - 1].text === ',') && task.nodes[i + 1]?.text === ':';
    record(reader, node, undefined, task.config === 'excluded', key);
    if (node.children) result.push({ nodes: node.children, depth: task.depth + 1, config: task.config });
    if (node.literal) result.push(...templateTasks(reader, node, { ...task, role: undefined }));
  }
  return result;
}
function configValue(reader: RoleReader, task: RoleTask, part: RoleToken[]): RoleTask[] {
  const property = propertyParts(part);
  if (!property) return [{ nodes: part, depth: task.depth + 1, config: 'excluded' }];
  const { key, value } = property,
    name = key.kind === 'group' ? undefined : propertyName(key, reader.source);
  record(reader, key, undefined, true, true);
  const keys: RoleTask[] = [{ nodes: [key], depth: task.depth + 1, config: 'excluded' }];
  let config: RoleTask['config'] = 'excluded';
  if (task.config === 'options' && name === 'variants') config = 'variants';
  if (task.config === 'options' && name === 'compoundVariants') config = 'compound-list';
  if (task.config === 'variants') config = 'values';
  if (task.config === 'values' || (task.config === 'compound' && (name === 'class' || name === 'className')))
    return [
      ...keys,
      { nodes: value, depth: task.depth + 1, role: { kind: 'cva-value', slot: 'cva-value', containers: true } },
    ];
  return [...keys, { nodes: value, depth: task.depth + 1, config }];
}
function cvaTasks(reader: RoleReader, task: RoleTask): RoleTask[] {
  const only = task.nodes.length === 1 ? task.nodes[0] : undefined;
  if (task.config === 'compound-list' && only?.text === '[')
    return splitTokens(only.children!).map((nodes) => ({ nodes, depth: task.depth + 1, config: 'compound' }));
  if (only?.text !== '{') return [{ ...task, config: 'excluded' }];
  return splitTokens(only.children!).flatMap((part) => configValue(reader, task, part));
}
function positiveTasks(reader: RoleReader, task: RoleTask): RoleTask[] {
  const { nodes, role } = task,
    only = nodes.length === 1 ? nodes[0] : undefined;
  if (only?.kind === 'literal') {
    record(reader, only, role);
    return templateTasks(reader, only, task);
  }
  if (role?.kind === 'cva-value') reader.result.contexts.push(tokenSpan(nodes));
  if (nodes.some((n) => n.text === '+'))
    reader.result.contexts.push({ ...tokenSpan(nodes), residual: 'dynamic class concatenation fragment excluded' });
  const object = objectTasks(task);
  if (object) {
    for (const key of object.keys) record(reader, key, childRole(role!, 'helper-key', 'object-key'), false, true);
    return object.values;
  }
  return expressionTasks(task) ?? opaqueTasks(reader, task);
}
export function walkValues(reader: RoleReader, tasks: RoleTask[]): void {
  const pending = tasks.slice().reverse();
  while (pending.length && reader.limit === undefined) {
    const task = pending.pop()!;
    if (!task.nodes.length) continue;
    if (task.depth >= ROLE_DEPTH) {
      depthGap(reader, task.nodes[0].start);
      break;
    }
    const children =
      task.config && task.config !== 'excluded'
        ? cvaTasks(reader, task)
        : task.role
          ? positiveTasks(reader, task)
          : opaqueTasks(reader, task);
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
  }
}
/** JSX attribute entities are runtime spelling, not JavaScript escapes. */
export function decodeAttribute(reader: RoleReader, node: RoleToken): void {
  if (node.kind !== 'literal' || node.text === '`') return;
  const state = reader.result.states.get(node.start);
  if (!state) return;
  let valid = true;
  const names: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  const cooked = reader.source.text.slice(node.start + 1, node.end - 1).replace(/&([^;]+);/g, (_raw, name: string) => {
    const number = /^#(?:x([\da-f]+)|(\d+))$/i.exec(name);
    if (number) {
      const value = parseInt(number[1] ?? number[2], number[1] ? 16 : 10);
      if (value <= 0x10ffff) return String.fromCodePoint(value);
    }
    if (names[name]) return names[name];
    valid = false;
    return '';
  });
  if (valid) {
    state.cooked = cooked;
    state.end = node.end;
  } else {
    state.role = undefined;
    reader.result.contexts.push({
      start: node.start,
      end: node.end,
      extractionGap: true,
      residual: 'encoded JSX class text unmeasured',
    });
  }
}
export function readRolePart(reader: RoleReader, part: Part): RoleToken[] {
  const parsed = roleTokens(reader.source, part);
  if (parsed.limit !== undefined) depthGap(reader, part.start);
  if (parsed.failed)
    reader.result.contexts.push({
      ...part,
      extractionGap: true,
      residual: 'class expression unreadable; positive values unmeasured',
    });
  return parsed.nodes;
}
