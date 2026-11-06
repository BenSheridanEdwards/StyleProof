/** Parse syntax, then grant explicit evidence only through approved AST value roles. */
import { parse, parseExpression, type ParserOptions } from '@babel/parser';
import type { Node } from '@babel/types';
import { classListMethod, cvaTasks, helperName, rootValue } from './class-join-role-roots.js';
import { literalRole, positiveChildren, syntaxChildren } from './class-join-role-children.js';
import type { ClassRoles, RoleTask, RoleState } from './class-join-role-types.js';
import { classSource, literalAt, type ClassSource } from './class-join-source.js';

function options(key: string): ParserOptions {
  return {
    sourceType: 'unambiguous',
    createParenthesizedExpressions: true,
    errorRecovery: true,
    plugins: /\.(?:[cm]?ts)$/i.test(key) ? ['typescript'] : ['typescript', 'jsx'],
  };
}
function needsContext(node: Node, source: ClassSource): boolean {
  if ((node.type === 'StringLiteral' || node.type === 'TemplateLiteral') && node.start != null) {
    const token = source.byStart.get(node.start);
    return !token || literalAt(source, token).end !== node.end;
  }
  return true;
}
function rootTasks(task: RoleTask, result: ClassRoles, source: ClassSource): RoleTask[] | undefined {
  if (task.context) return;
  const node = task.node,
    value = rootValue(node);
  if (value) {
    if (needsContext(value.node, source))
      result.contexts.push({ start: value.node.start ?? 0, end: value.node.end ?? 0 });
    return syntaxChildren(task).map((child) =>
      child.node === value.node ? { ...child, context: true, role: value.role } : child,
    );
  }
  return callRoot(task, result, source);
}
function callRoot(task: RoleTask, result: ClassRoles, source: ClassSource): RoleTask[] | undefined {
  const { node } = task;
  if (node.type === 'CallExpression' && (helperName(node) || classListMethod(node))) {
    const positive = !!helperName(node) || ['add', 'replace'].includes(classListMethod(node) ?? '');
    if (positive) result.contexts.push({ start: node.start ?? 0, end: node.end ?? 0 });
    return positiveChildren(
      { ...task, context: true, ...(positive ? { role: { kind: 'class-call', slot: 'class-call' } } : {}) },
      source,
    );
  }
}
function record(task: RoleTask, result: ClassRoles): void {
  const { node } = task,
    at = node.start;
  if (at == null) return;
  if (node.type !== 'StringLiteral' && node.type !== 'TemplateLiteral' && !(task.key && node.type === 'Identifier'))
    return;
  const previous = result.states.get(at),
    role = literalRole(task) ?? previous?.role;
  result.states.set(at, {
    context: task.context || !!previous?.context,
    ...(role ? { role } : {}),
    ...(task.key && node.type === 'Identifier' ? { bareEnd: node.end ?? at } : {}),
    ...cookedState(node),
    ...(task.config === 'excluded' && !role ? { excluded: true } : {}),
  });
}
function cookedState(node: Node): Pick<RoleState, 'cooked' | 'end' | 'escapedTemplate'> {
  if (node.type === 'StringLiteral') return { cooked: node.value, end: node.end ?? node.start ?? 0 };
  if (node.type !== 'TemplateLiteral') return {};
  if (node.expressions.length === 0 && node.quasis[0]?.value.cooked != null)
    return { cooked: node.quasis[0].value.cooked, end: node.end ?? node.start ?? 0 };
  return node.quasis.some((q) => q.value.raw.includes('\\')) ? { escapedTemplate: true } : {};
}
function valueContexts(task: RoleTask, result: ClassRoles): void {
  const node = task.node;
  if (task.role?.kind === 'cva-value') result.contexts.push({ start: node.start ?? 0, end: node.end ?? 0 });
  if (task.role && node.type === 'BinaryExpression' && node.operator === '+')
    result.contexts.push({
      start: node.start ?? 0,
      end: node.end ?? 0,
      residual: 'dynamic class concatenation fragment excluded',
    });
}
function walk(root: Node, source: ClassSource, expression: boolean): ClassRoles {
  const result: ClassRoles = { states: new Map(), contexts: [] };
  const pending: RoleTask[] = [
    {
      node: root,
      context: expression,
      ...(expression ? { role: { kind: 'class-value', slot: 'class-value', containers: true } } : {}),
    },
  ];
  while (pending.length) {
    const task = pending.pop()!;
    if (task.config && task.config !== 'excluded') {
      pending.push(...cvaTasks(task));
      continue;
    }
    record(task, result);
    valueContexts(task, result);
    if (task.node.type === 'Identifier' && !task.key) continue;
    const roots = rootTasks(task, result, source);
    pending.push(...(roots ?? positiveChildren(task, source)));
  }
  return result;
}
/** Script blocks use JS/TS syntax; markup bindings are read separately at exact offsets. */
export function scriptParts(
  source: ClassSource,
  key: string,
): { start: number; end: number; key: string }[] | undefined {
  if (!/\.(?:vue|svelte|astro)$/i.test(key)) return;
  return [...source.text.matchAll(/<script\b([^>]*)>([^]*?)<\/script\s*>/gi)].map((match) => {
    const start = match.index + match[0].indexOf('>') + 1;
    return {
      start,
      end: start + match[2].length,
      key: /\blang\s*=\s*['"](?:ts|typescript)['"]/i.test(match[1]) ? 'block.ts' : 'block.tsx',
    };
  });
}
function scriptRoles(source: ClassSource, scripts: NonNullable<ReturnType<typeof scriptParts>>): ClassRoles {
  const combined: ClassRoles = { states: new Map(), contexts: [] };
  for (const part of scripts) {
    const local = classRoles(classSource(source.text.slice(part.start, part.end), part.key), part.key);
    for (const [at, state] of local.states)
      combined.states.set(at + part.start, {
        ...state,
        ...(state.bareEnd !== undefined ? { bareEnd: state.bareEnd + part.start } : {}),
        ...(state.end !== undefined ? { end: state.end + part.start } : {}),
      });
    combined.contexts.push(
      ...local.contexts.map((c) => ({ ...c, start: c.start + part.start, end: c.end + part.start })),
    );
    if (local.failed)
      combined.contexts.push({
        start: part.start,
        end: part.end,
        residual: 'class role syntax unreadable; positive values unmeasured',
        extractionGap: true,
      });
  }
  return combined;
}
/** Ordinary vocabulary-only blobs need no AST; malformed supported syntax fails conservatively. */
export function classRoles(source: ClassSource, key: string, expression = false): ClassRoles {
  const scripts = scriptParts(source, key);
  if (scripts) return scriptRoles(source, scripts);
  if (
    !expression &&
    !source.text.includes('\\') &&
    !source.tokens.some((token) =>
      /^(?:['"](?:class|className|classList)['"]|class|className|classList|clsx|cx|cn|classnames|classNames|cva|twMerge|twJoin)$/.test(
        source.text.slice(token.index, token.end),
      ),
    )
  )
    return { states: new Map(), contexts: [] };
  try {
    const root = expression ? parseExpression(source.text, options(key)) : parse(source.text, options(key));
    if ('errors' in root && root.errors?.length) return { states: new Map(), contexts: [], failed: true };
    return walk(root, source, expression);
  } catch {
    return { states: new Map(), contexts: [], failed: true };
  }
}
