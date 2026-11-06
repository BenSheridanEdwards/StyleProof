/** The allow-list: a node may pass a positive role only to these value positions. */
import { VISITOR_KEYS, type Node } from '@babel/types';
import { helperName, classListMethod } from './class-join-role-roots.js';
import { childRole, type RoleTask, type PositiveRole } from './class-join-role-types.js';
import { literalAt, type ClassSource } from './class-join-source.js';

export function syntaxChildren(task: RoleTask): RoleTask[] {
  const fields = task.node as unknown as Record<string, Node | Node[] | null>;
  return (VISITOR_KEYS[task.node.type] ?? []).flatMap((key) => {
    const value = fields[key],
      nodes = Array.isArray(value) ? value : value ? [value] : [];
    return nodes.filter(Boolean).map((node) => ({
      node,
      context: task.context,
      key: key === 'key' && (task.node.type === 'ObjectProperty' || task.node.type === 'ObjectMethod'),
      ...(task.config === 'excluded' ? { config: 'excluded' as const } : {}),
    }));
  });
}
function callChildren(task: RoleTask): RoleTask[] | undefined {
  const node = task.node;
  if (node.type !== 'CallExpression') return;
  const helper = helperName(node),
    method = classListMethod(node);
  if (!helper && method !== 'add' && method !== 'replace') return;
  return node.arguments.map((arg, i) => ({
    node: arg,
    context: true,
    ...(helper === 'cva' && i > 0
      ? { config: 'options' as const }
      : helper || method === 'add' || i === 1
        ? { role: { kind: 'helper-argument', slot: `argument:${i}`, containers: !!helper } }
        : {}),
  }));
}
function containerChildren(task: RoleTask, role: PositiveRole): RoleTask[] | undefined {
  const node = task.node;
  if (node.type === 'ArrayExpression' && role.containers)
    return node.elements.flatMap((n, i) =>
      n ? [{ node: n, context: true, role: childRole(role, 'array-element', `array:${i}`) }] : [],
    );
  if (node.type === 'ObjectExpression' && role.containers)
    return node.properties.flatMap((prop) => {
      if ((prop.type !== 'ObjectProperty' && prop.type !== 'ObjectMethod') || prop.computed)
        return [{ node: prop, context: true }];
      const children = syntaxChildren({ node: prop, context: true });
      return children.map((child) =>
        child.key ? { ...child, role: childRole(role, 'helper-key', 'object-key') } : child,
      );
    });
}
export function positiveChildren(task: RoleTask, source: ClassSource): RoleTask[] {
  const { node, role } = task;
  if (!role) return syntaxChildren(task);
  const calls = callChildren(task),
    containers = containerChildren(task, role);
  if (calls) return calls;
  if (containers) return containers;
  if (node.type === 'ParenthesizedExpression' || node.type === 'JSXExpressionContainer')
    return [{ node: node.expression, context: true, role }];
  if (node.type === 'ConditionalExpression')
    return [
      { node: node.test, context: true },
      { node: node.consequent, context: true, role: childRole(role, 'ternary-result', 'ternary:then') },
      { node: node.alternate, context: true, role: childRole(role, 'ternary-result', 'ternary:else') },
    ];
  if (node.type === 'LogicalExpression')
    return [
      { node: node.left, context: true },
      { node: node.right, context: true, role: childRole(role, 'logical-result', `logical:${node.operator}:rhs`) },
    ];
  if (node.type === 'TemplateLiteral' && node.start != null) {
    const token = source.byStart.get(node.start);
    const parts = token ? literalAt(source, token).substitutions : [];
    return node.expressions.map((expression, i) => ({
      node: expression,
      context: true,
      ...(parts[i]?.whole ? { role: childRole(role, 'template-value', `template:${i}`) } : {}),
    }));
  }
  return syntaxChildren(task);
}
export function literalRole(task: RoleTask): string | undefined {
  if (!task.role) return;
  if (
    task.node.type === 'StringLiteral' ||
    task.node.type === 'TemplateLiteral' ||
    (task.key && task.node.type === 'Identifier')
  )
    return `${task.role.kind}:${task.role.slot}`;
}
