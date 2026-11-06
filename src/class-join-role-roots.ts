/** Only statically named class sources introduce positive expression roots. */
import type * as t from '@babel/types';
import type { PositiveRole, RoleTask } from './class-join-role-types.js';
const helpers = new Set(['clsx', 'cx', 'classnames', 'classNames', 'cva', 'twMerge', 'twJoin', 'cn']);
export function helperName(node: t.CallExpression): string | undefined {
  return !node.optional &&
    !node.typeParameters &&
    !node.typeArguments &&
    node.callee.type === 'Identifier' &&
    helpers.has(node.callee.name)
    ? node.callee.name
    : undefined;
}
export function propertyName(node: t.Node): string | undefined {
  if (node.type === 'Identifier' || node.type === 'JSXIdentifier') return node.name;
  if (node.type === 'StringLiteral') return node.value;
}
export function classListMethod(node: t.CallExpression): string | undefined {
  const callee = node.callee;
  return callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'MemberExpression' &&
    !callee.object.computed &&
    propertyName(callee.object.property) === 'classList'
    ? propertyName(callee.property)
    : undefined;
}
function classMember(node: t.Node): string | undefined {
  if (node.type !== 'MemberExpression' || node.computed) return;
  const key = propertyName(node.property);
  if (node.object.type === 'MemberExpression' && propertyName(node.object.property) === 'dataset') return;
  return key === 'className' ? key : undefined;
}
export function valueRole(key: string): PositiveRole {
  return { kind: 'class-value', slot: 'class-value', containers: key === 'class' || key === 'classList' };
}
export function rootValue(node: t.Node): { node: t.Node; role: PositiveRole } | undefined {
  if (node.type === 'AssignmentExpression' && node.operator === '=') {
    const key = classMember(node.left);
    if (key) return { node: node.right, role: valueRole(key) };
  }
  if (node.type === 'JSXAttribute') {
    const key = propertyName(node.name);
    if (node.value && (key === 'class' || key === 'className' || key === 'classList'))
      return { node: node.value, role: valueRole(key) };
  }
  if (node.type === 'ObjectProperty' && !node.computed) {
    const key = propertyName(node.key);
    if (key === 'class' || key === 'className' || key === 'classList')
      return { node: node.value, role: valueRole(key) };
  }
}
/** Configuration keys/selection values are data; only declared cva class values qualify. */
export function cvaTasks(task: RoleTask): RoleTask[] {
  const { node, config } = task;
  if (config === 'compound-list' && node.type === 'ArrayExpression')
    return node.elements.flatMap((n) => (n ? [{ node: n, context: true, config: 'compound' as const }] : []));
  if (node.type !== 'ObjectExpression') return [{ ...task, config: 'excluded' }];
  return node.properties.flatMap((prop) => {
    if (prop.type !== 'ObjectProperty') return [{ node: prop, context: false, config: 'excluded' as const }];
    const name = prop.computed ? undefined : propertyName(prop.key);
    const key: RoleTask = { node: prop.key, context: false, key: true, config: 'excluded' };
    const value: RoleTask = { node: prop.value, context: true, config: 'excluded' };
    if (config === 'options' && name === 'variants') value.config = 'variants';
    if (config === 'options' && name === 'compoundVariants') value.config = 'compound-list';
    if (config === 'variants') value.config = 'values';
    if (config === 'values' || (config === 'compound' && (name === 'class' || name === 'className'))) {
      value.config = undefined;
      value.role = { kind: 'cva-value', slot: 'cva-value', containers: true };
    }
    return [key, value];
  });
}
