import type {GraphicsType, ContractImplementation, ContractNode} from './contracts.mjs';
export type Role = 'input' | 'fit';
export type Ownership = {id: string; role: Role};
export type Extent = {relativeTo: 'input' | 'presentation'; factor: number} | {width?: number; height?: number};
export type RowLike = {id: string; kind: string; enabled: boolean; ownedBy?: Ownership; method?: string; settings?: object;
  shader?: {preset?: string; effectPath?: string | null; effects?: string[] | null; parameters?: Record<string, number[]> | null};
  extent?: object; outputSize?: {width?: number; height?: number}; presentationScale?: number};
export type PlanLike<R extends RowLike = RowLike> = {schema: 1 | 2; mode: 'advanced'; enabled?: boolean; video: R[];
  renderResolution?: {managedBy?: string; [key: string]: unknown} | null; output?: {[key: string]: unknown}; depthInput?: {[key: string]: unknown}};
export type CatalogRow = ContractImplementation & {id: string; label?: string; kind?: string; template: ContractNode & {enabled?: boolean};
  nodeId?: string; selectionKey?: string; modelOperation?: string; runtimeManagerId?: string; available?: boolean};
export interface EditContext<C extends CatalogRow = CatalogRow> {
  readonly catalog: readonly C[];
  readonly library: readonly C[];
  readonly nativeVideo: boolean;
  implementation(row: RowLike): C | undefined;
  type(row: RowLike): GraphicsType;
  newId(): string;
}
export type EditContextOptions<C extends CatalogRow> = {nativeVideo?: boolean; newId?: () => string;
  implementation?: (row: RowLike, matched: C | undefined) => C | undefined};
export type SlotProjection<R> = {id: GraphicsType; label: string; rows: R[]; row?: R; custom: boolean};
export type Projection<R extends RowLike = RowLike> = {slots: SlotProjection<R>[]; imageRows: R[]; helpers: ReadonlyMap<string, R[]>;
  types: ReadonlyMap<string, GraphicsType>; customOrder: boolean};
export type Violation = {code: 'O1' | 'O2' | 'O3' | 'O4' | 'O5' | 'O6' | 'O7'; message: string; rowId?: string};
export type RowPatch = {shader?: {[key: string]: unknown}; settings?: {[key: string]: unknown}};
export const SIMPLE_ORDER: readonly GraphicsType[];

export function createEditContext<C extends CatalogRow>(catalog?: readonly C[], options?: EditContextOptions<C>): EditContext<C>;
export function project<R extends RowLike>(plan: PlanLike<R>, ctx: EditContext): Projection<R>;
export function check(plan: PlanLike, ctx?: EditContext): Violation[];
export function migrateOwnership<T>(plan: T): T;
export function normalizeFits<P extends PlanLike>(plan: P, ctx: EditContext): P;
export function rebase<P extends PlanLike>(current: P | null | undefined, base: P | null | undefined, desired: P): P;

export function setSlot<P extends PlanLike>(plan: P, slot: GraphicsType, rowId: string | null, choice: CatalogRow | null, ctx: EditContext, options?: {extent?: Extent}): P;
export function setEnabled<P extends PlanLike>(plan: P, rowId: string, enabled: boolean, ctx: EditContext): P;
export function remove<P extends PlanLike>(plan: P, rowId: string, ctx?: EditContext): P;
export function move<P extends PlanLike>(plan: P, rowId: string, to: number, ctx: EditContext): P;
export function setExtent<P extends PlanLike>(plan: P, rowId: string, extent: Extent | null, ctx: EditContext, options?: {asOwner?: boolean}): P;
export function setSettings<P extends PlanLike>(plan: P, rowId: string, patch: RowPatch, ctx: EditContext): P;
export function add<P extends PlanLike>(plan: P, choice: CatalogRow, ctx: EditContext, options?: {type?: GraphicsType; view?: 'simple' | 'advanced'}): {plan: P; id: string};
export function changeMethod<P extends PlanLike>(plan: P, rowId: string, choice: CatalogRow, ctx: EditContext): P;
export function placeImported<P extends PlanLike>(plan: P, choices: readonly CatalogRow[], target: {rowId?: string; slot?: GraphicsType}, ctx: EditContext, view?: 'simple' | 'advanced'): {plan: P; incompatible: string[]};
export function setSource<P extends PlanLike>(plan: P, value: P['renderResolution'] | null | undefined): P;
export function setOutput<P extends PlanLike>(plan: P, patch: Partial<NonNullable<P['output']>>): P;
export function setDepthInput<P extends PlanLike>(plan: P, patch: Partial<{reversed: boolean; logarithmic: boolean; farPlane: number; multiplier: number}>): P;
export function setMaster<P extends PlanLike>(plan: P, enabled: boolean): P;
export function clear<P extends PlanLike>(plan: P): P;
