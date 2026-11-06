/** Positive roles are transient syntax evidence, never render provenance. */
import type { Node } from '@babel/types';
export type PositiveRole = { kind: string; slot: string; containers?: boolean };
export type RoleTask = {
  node: Node;
  context: boolean;
  role?: PositiveRole;
  key?: boolean;
  config?: 'options' | 'variants' | 'values' | 'compound-list' | 'compound' | 'excluded';
};
export type RoleState = {
  context: boolean;
  role?: string;
  bareEnd?: number;
  excluded?: boolean;
  cooked?: string;
  end?: number;
  escapedTemplate?: true;
};
export type RoleContext = { start: number; end: number; residual?: string; extractionGap?: true };
export type ClassRoles = { states: Map<number, RoleState>; contexts: RoleContext[]; failed?: true };
export const childRole = (parent: PositiveRole, kind: string, slot: string): PositiveRole => ({
  kind,
  slot: `${parent.slot}/${slot}`,
  containers: parent.containers,
});
