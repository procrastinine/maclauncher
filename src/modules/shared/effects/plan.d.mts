import type {SceneInputRequirements} from './operation-contracts.mjs';
export type EffectKind = 'shader' | 'spatial' | 'downsample' | 'upscale' | 'temporal' | 'neural' | 'frame-generation';
export type ShaderSettings = { enabled?: boolean; preset?: string; effectPath?: string | null; effects?: string[] | null; parameters?: Record<string, number[]> | null };
export type GraphicsSettings = Record<string, string | number | boolean | null>;
export type ModelInputSettings = {modelPath:string|null};
export type HelperRole = 'input' | 'fit';
export type Ownership = {id: string; role: HelperRole};
export type ShaderNode = { id: string; kind: 'shader'; enabled: boolean; shader: ShaderSettings;settings?:ModelInputSettings;extent?:EffectExtent;ownedBy?:Ownership };
export type EffectExtent = {relativeTo: 'input' | 'presentation'; factor: number} | {relativeTo:'presentation';automatic:true} | {width?: number; height?: number};
export type GraphicsNode = { id: string; kind: 'spatial' | 'downsample' | 'upscale' | 'temporal' | 'neural' | 'frame-generation'; enabled: boolean; method: string; settings: GraphicsSettings; outputSize?: {width?: number; height?: number}; presentationScale?: number; extent?: EffectExtent; ownedBy?: Ownership };
export type EffectNode = ShaderNode | GraphicsNode;
export type EffectsPlan = { schema: 1 | 2; mode: 'advanced'; enabled?: boolean; video: EffectNode[]; output?: {toneMapping?:'auto'|'preserve'|'reinhard'|'pbr-neutral';adaptiveQuality?:{enabled?:boolean;nodeId:string;budgetMs?:number;minScale?:number;maxScale?:number};comparison?:{mode:'off'|'before'|'wipe'|'difference';position?:number;gain?:number};motionClarity?: 'off' | 'bfi' | 'beam'; subframes?: number; duty?: number; brightness?: number;framePacing?:'fixed'|'adaptive';targetFps?:number;smoothCadence?:boolean}; depthInput?: Partial<DepthInput>; renderResolution?: {height: number; maximum?: true; method?: string; managedBy?: string} | {multiplier: number; method?: string; managedBy?: string} };
/** ReShade depth-input definitions for the game's .fx rows that read depth. */
export type DepthInput = {reversed: boolean; logarithmic: boolean; farPlane: number; multiplier: number};
export const DEPTH_INPUT_DEFAULTS: Readonly<DepthInput>;
export function depthInput(value: unknown): DepthInput;
export const MAX_NODES: number;
export const MAX_PARAMETERS: number;
export const DEFAULT_PROCESSING_HEIGHT: number;
export const RENDER_DIVISORS: readonly number[];
export function validRenderDivisor(value: unknown): boolean;
export function validate(value: unknown): EffectsPlan;
export const HELPER_ROLES: readonly HelperRole[];
export function ownsHelpers(value: unknown): boolean;
export const PLAN_INVALID: 'GRAPHICS_PLAN_INVALID';
export const PLAN_NEWER: 'GRAPHICS_PLAN_NEWER';
export type PlanError = {code: typeof PLAN_INVALID | typeof PLAN_NEWER; message: string};
/** `{plan: null}` for an absent value (null or undefined); never throws. */
export type PlanInspection = {plan: EffectsPlan | null; error?: undefined} | {plan?: undefined; error: PlanError};
export function planError(value: unknown, error: unknown): PlanError;
export function inspect(value: unknown): PlanInspection;
/** `null` only for an absent value; an invalid plan throws an Error carrying its PlanError `code`. */
export function normalize(value: unknown): EffectsPlan | null;
/** A part of a plan that row-level salvage left out: a row (`id` is its row ID, or `#n` when unreadable), the source request, an output setting (`output.<name>`) or the depth input. */
export type DroppedPart = {part: 'row' | 'renderResolution' | 'output' | 'depthInput'; id: string; reason: string; label?: string};
/** Never throws. Only a broken envelope or a newer schema is an `error`; any other invalid part is dropped on its own. */
export type PlanSalvage = {plan: EffectsPlan | null; dropped: DroppedPart[]; error?: undefined} | {plan?: undefined; dropped?: undefined; error: PlanError};
export function salvage(value: unknown, check?: (value: unknown) => EffectsPlan): PlanSalvage;
export function migrate(value: unknown): EffectsPlan;
export function execution(value: unknown): EffectsPlan;
export function isResize(value: unknown): boolean;
/** The saved plan, else the legacy Simple conversion; an invalid saved plan throws as in `normalize`. */
export function fromLegacy(entry?: { effects?: unknown; reshade?: ShaderSettings; graphics?: object }): EffectsPlan;
export type ShaderFacts = Record<string, { requirements?: Partial<SceneInputRequirements> | string[]; traits?: Record<string, unknown> }>;
export function orderSimple(value: unknown, options?: {shaderFacts?: ShaderFacts}): EffectsPlan;
export function composeSimple(entry?: {effects?: unknown; reshade?: ShaderSettings; graphics?: object}, options?: {shaderFacts?: ShaderFacts}): EffectsPlan;
export function reconstructionPreset(entry?: {effects?: unknown; reshade?: ShaderSettings; graphics?: object}, options?: {
  divisor?: 1 | 1.5 | 2 | 4; spatialMethod?: string; frameMultiplier?: number; shaderFacts?: ShaderFacts;
}): EffectsPlan;
export function leading(value: EffectsPlan, count: number): EffectsPlan;
export type OrderingCapabilities = { nodes?: Record<string, { available?: boolean; reason?: string; preservesCoordinates?: boolean; coordinateTransform?:'identity'|'scale'|'unknown'; preservesSceneInputs?:boolean; requirements?: Partial<SceneInputRequirements> }> };
export function validateOrdering(value: unknown, capabilities?: OrderingCapabilities): EffectsPlan;
/** Each enabled row that breaks the order (or is unavailable), checked against the rows before it that pass. */
export function orderingFailures(value: unknown, capabilities?: OrderingCapabilities): {id: string; reason: string; unavailable?: true}[];
