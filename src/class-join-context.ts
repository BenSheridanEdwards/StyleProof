/** Grant explicit evidence only through approved roles in the existing lexer. */
import { classListMethod, callTasks, helperName, rootValue, objectGroup } from './class-join-role-roots.js';
import { markTypeScopes } from './class-join-type-scope.js';
import { roleTokens, splitTokens, type RoleToken } from './class-join-role-tokens.js';
import { decodeAttribute, depthGap, readRolePart, walkValues, type RoleReader } from './class-join-role-walk.js';
import type { ClassRoles } from './class-join-role-types.js';
import { classSource, type ClassSource } from './class-join-source.js';
function declarationCall(nodes: RoleToken[], index: number, member: boolean): boolean {
  const before = nodes[index - 1]?.text,
    after = nodes[index + 2];
  if (before === 'function' || (before === '*' && nodes[index - 2]?.text === 'function')) return true;
  if (after?.text === '{' || (after?.text === ':' && nodes[index + 3]?.typeOnly)) return true;
  return member && !['=', 'return', '(', ',', ':', '?', '=>', '&&', '||', '??'].includes(before);
}
function callRoot(reader: RoleReader, nodes: RoleToken[], index: number, member: boolean): number | undefined {
  const node = nodes[index],
    call = nodes[index + 1];
  if (node.kind !== 'word' || call?.text !== '(' || call.kind !== 'group' || declarationCall(nodes, index, member))
    return;
  const helper = helperName(node.text) && !['.', '?.', 'new'].includes(nodes[index - 1]?.text);
  if (!helper && !classListMethod(nodes, index)) return;
  if (helper || node.text === 'add' || node.text === 'replace')
    reader.result.contexts.push({ start: node.start, end: call.end });
  walkValues(reader, callTasks(node.text, splitTokens(call.children!), 0, helper));
  return index + 2;
}
function valueRoot(reader: RoleReader, nodes: RoleToken[], index: number, object: boolean): number | undefined {
  const root = rootValue(reader.source, nodes, index, object);
  if (!root) return;
  const only = root.values.length === 1 ? root.values[0] : undefined;
  if (only?.kind !== 'literal') reader.result.contexts.push(root.span);
  walkValues(reader, [{ nodes: root.values, role: root.role, depth: 0 }]);
  if (root.attribute && only) decodeAttribute(reader, only);
  return root.end;
}
type Discovery = { nodes: RoleToken[]; parent: string; object: boolean; scope?: 'class' };
type Header = { scope?: 'class'; angles: number };
function declarationHeader(nodes: RoleToken[], index: number): Header['scope'] {
  const node = nodes[index];
  if (node.kind !== 'word' || nodes[index + 1]?.text === ':' || nodes[index - 1]?.text === '.') return;
  if (node.text === 'class') return 'class';
}
function headerStep(header: Header, nodes: RoleToken[], index: number): void {
  const node = nodes[index];
  if (node.kind === 'word') {
    header.scope = declarationHeader(nodes, index) ?? header.scope;
    return;
  }
  if (node.kind !== 'operator') return;
  if (!header.scope) return;
  if (node.text === '<') header.angles++;
  if (/^>{1,3}$/.test(node.text)) header.angles = Math.max(0, header.angles - node.text.length);
  if (node.text === ';') header.scope = undefined;
}
function discoveryChildren(reader: RoleReader, part: Discovery, index: number, header: Header): Discovery[] {
  const node = part.nodes[index];
  const children: Discovery[] = node.children
    ? [
        {
          nodes: node.children,
          parent: node.text,
          object: objectGroup(part.nodes, index, part.parent),
          scope: node.text === '{' ? header.scope : undefined,
        },
      ]
    : [];
  if (node.text === '{' && header.angles === 0) header.scope = undefined;
  return [
    ...children,
    ...(node.literal?.substitutions ?? []).map((substitution) => ({
      nodes: readRolePart(reader, substitution),
      parent: '',
      object: false,
    })),
  ];
}
function discoverPart(reader: RoleReader, part: Discovery, pending: Discovery[]): void {
  const header: Header = { angles: 0 };
  for (let i = 0; i < part.nodes.length && reader.limit === undefined; i++) {
    headerStep(header, part.nodes, i);
    if (part.nodes[i].typeOnly) continue;
    const end =
      valueRoot(reader, part.nodes, i, part.object && part.scope !== 'class') ??
      callRoot(reader, part.nodes, i, part.scope === 'class');
    if (end !== undefined) {
      i = end - 1;
      continue;
    }
    const node = part.nodes[i];
    if (node.children || node.literal?.substitutions.length)
      discoveryChildren(reader, part, i, header).forEach((child) => pending.push(child));
  }
}
function discover(reader: RoleReader, nodes: RoleToken[]): void {
  const pending: Discovery[] = [{ nodes, parent: '', object: false }];
  while (pending.length && reader.limit === undefined) discoverPart(reader, pending.pop()!, pending);
}
/** Component script blocks and markup bindings retain separate, exact source offsets. */
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
    local.contexts.forEach((c) =>
      combined.contexts.push({ ...c, start: c.start + part.start, end: c.end + part.start }),
    );
    if (local.failed)
      combined.contexts.push({
        start: part.start,
        end: part.end,
        extractionGap: true,
        residual: 'class expression unreadable; positive values unmeasured',
      });
  }
  return combined;
}
export function classRoles(source: ClassSource, key: string, expression = false): ClassRoles {
  const scripts = scriptParts(source, key);
  if (scripts) return scriptRoles(source, scripts);
  const result: ClassRoles = { states: new Map(), contexts: [] },
    reader: RoleReader = { source, result };
  if (
    !expression &&
    !source.tokens.some((token) =>
      /^(?:['"](?:class|className|classList)['"]|class|className|classList|clsx|cx|cn|classnames|classNames|cva|twMerge|twJoin)$/.test(
        source.text.slice(token.index, token.end),
      ),
    )
  )
    return result;
  const parsed = roleTokens(source);
  if (parsed.failed) return { ...result, failed: true };
  markTypeScopes(parsed.nodes, source.text);
  if (expression)
    walkValues(reader, [
      { nodes: parsed.nodes, role: { kind: 'class-value', slot: 'class-value', containers: true }, depth: 0 },
    ]);
  else discover(reader, parsed.nodes);
  if (parsed.limit !== undefined) depthGap(reader, parsed.limit);
  return result;
}
