import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { StyleMap, Props } from './capture/types.js';
import type { ChannelBody } from './capture/visual-channels.js';

export const isChannelProperty = (property: string): boolean =>
  property === 'img currentSrc' || property.startsWith('animation keyframes (');

/** Unknown/capture absence is a limit, never a change. */
export function channelValuesDiffer(
  property: string,
  before: string,
  after: string,
  unsetA: string,
  unsetB: string,
): boolean {
  if (before === '(keyframes unknown; not compared)' || after === '(keyframes unknown; not compared)') return false;
  if (property === 'img currentSrc' && (!before || !after || before === unsetA || after === unsetB)) return false;
  return before !== after;
}

/** All compared property layers, including pseudo-elements and forced states. */
function propertyLayers(map: StyleMap): Props[] {
  const layers: Props[] = [];
  for (const element of Object.values(map.elements)) {
    layers.push(element.style);
    for (const pseudo of Object.values(element.pseudo ?? {})) layers.push(pseudo);
  }
  for (const states of Object.values(map.states))
    for (const targets of Object.values(states)) for (const target of Object.values(targets)) layers.push(target);
  return layers;
}

/** Hash after transfer so data URLs and shared keyframe bodies use native SHA-256, with no dependency. */
export function finalizeVisualChannels(map: StyleMap, bodies: ChannelBody[]): void {
  const keyframes: NonNullable<StyleMap['visualChannels']>['keyframes'] = {};
  const ids = new Map<string, string>();
  const keyframeReference = (value: string): string => {
    if (value === '(gone)') return value;
    let id = ids.get(value);
    if (id === undefined) {
      const body = bodies[Number(value)];
      if (!body) throw new Error('styleproof: missing captured keyframes body');
      const hash = body.body === undefined ? undefined : createHash('sha256').update(body.body).digest('hex');
      id = JSON.stringify([body.name, body.status ?? hash ?? 'unknown']);
      keyframes[id] = {
        ...body,
        ...(body.status === 'none'
          ? { status: 'none' as const }
          : hash
            ? { hash, status: 'known' as const }
            : { status: 'unknown' as const }),
      };
      ids.set(value, id);
    }
    return id;
  };
  const normalize = (property: string, value: string): string => {
    if (property === 'img currentSrc' && value.startsWith('data:'))
      return `data:sha256:${createHash('sha256').update(value).digest('hex')}`;
    return property.startsWith('animation keyframes (') ? keyframeReference(value) : value;
  };
  for (const properties of propertyLayers(map)) {
    for (const [property, value] of Object.entries(properties)) properties[property] = normalize(property, value);
  }
  map.visualChannels = {
    version: 1,
    keyframes: Object.fromEntries(Object.entries(keyframes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
}

/** Project references to canonical bodies for the normal diff, or omit both sides' uncaptured evidence. */
export function comparableVisualChannels(map: StyleMap, compared: boolean): StyleMap {
  if (!map.visualChannels && compared) return map;
  const copy: StyleMap = { ...map, elements: {}, states: {} };
  const project = (properties: Props): Props =>
    Object.fromEntries(
      Object.entries(properties).flatMap(([property, value]) => {
        if (!isChannelProperty(property)) return [[property, value]];
        if (!compared) return [];
        if (property === 'img currentSrc') return [[property, value]];
        if (value === '(gone)') return [[property, value]];
        const frame = map.visualChannels?.keyframes?.[value];
        return [
          [
            property,
            frame?.status === 'none' ? '(no @keyframes)' : (frame?.body ?? '(keyframes unknown; not compared)'),
          ],
        ];
      }),
    );
  for (const [path, element] of Object.entries(map.elements))
    copy.elements[path] = {
      ...element,
      style: project(element.style),
      ...(element.pseudo
        ? {
            pseudo: Object.fromEntries(
              Object.entries(element.pseudo).map(([pseudo, properties]) => [pseudo, project(properties)]),
            ),
          }
        : {}),
    };
  for (const [owner, states] of Object.entries(map.states))
    copy.states[owner] = Object.fromEntries(
      Object.entries(states).map(([state, targets]) => [
        state,
        Object.fromEntries(Object.entries(targets).map(([path, properties]) => [path, project(properties)])),
      ]),
    );
  return copy;
}

/** The self-check must also catch missing/unknown evidence that the compatibility diff deliberately skips. */
export function assertDeterministicVisualChannels(first: StyleMap, again: StyleMap, surface: string): void {
  const evidence = (map: StyleMap): unknown => [
    map.visualChannels,
    propertyLayers(map).map((properties) =>
      Object.fromEntries(Object.entries(properties).filter(([property]) => isChannelProperty(property))),
    ),
  ];
  if (!isDeepStrictEqual(evidence(first), evidence(again)))
    throw new Error(
      `styleproof self-check failed: ${surface} is non-deterministic — keyframes/currentSrc evidence changed or is missing.`,
    );
}
