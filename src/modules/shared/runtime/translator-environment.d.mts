export type TranslatorEnvironmentKey = { key: string; description: string; launcher?: string };
export type TranslatorEnvironmentLock = { key: string; reason: string } | { prefix: string; reason: string };
export type TranslatorEnvironmentDeclaration = {
  id: string; label: string; description?: string; managerIds: readonly string[];
  keys: readonly TranslatorEnvironmentKey[]; locked: readonly TranslatorEnvironmentLock[];
  defaults: Readonly<Record<string, string>>;
};
/** A null value removes a variable inherited from a lower layer. */
export type TranslatorEnvironmentValues = Record<string, string | null>;
export type TranslatorEnvironmentStore = Record<string, TranslatorEnvironmentValues>;
export type TranslatorEnvironmentSource = "default" | "global" | "game";
export type TranslatorEnvironmentRow = {
  name: string; value: string | null; state: "inherited" | "changed" | "added" | "removed";
  inheritedValue?: string; inheritedSource?: TranslatorEnvironmentSource;
  known: TranslatorEnvironmentKey | null; locked: TranslatorEnvironmentLock | null;
};

export const LIMITS: Readonly<{ entries: number; name: number; value: number }>;
export const SOURCES: readonly TranslatorEnvironmentSource[];
export function isVariableName(name: unknown): name is string;
export function isVariableValue(value: unknown): value is string;
export function isTranslatorId(id: unknown): id is string;
export function normalizeDeclaration(input: unknown): TranslatorEnvironmentDeclaration;
export function lockedRule(declarations: readonly TranslatorEnvironmentDeclaration[] | null | undefined, name: string): TranslatorEnvironmentLock | null;
export function knownVariable(declaration: TranslatorEnvironmentDeclaration | null | undefined, name: string): TranslatorEnvironmentKey | null;
export function normalizeValues(values: unknown, options?: { declarations?: readonly TranslatorEnvironmentDeclaration[] }): TranslatorEnvironmentValues;
export function readValues(values: unknown): TranslatorEnvironmentValues;
export function readStore(store: unknown): TranslatorEnvironmentStore;
export function withValues(store: unknown, id: string, values: unknown): TranslatorEnvironmentStore;
export function effectiveValues(declaration: TranslatorEnvironmentDeclaration,
  values?: { global?: unknown; game?: unknown },
  options?: { through?: TranslatorEnvironmentSource }): { values: Record<string, string>; sources: Record<string, TranslatorEnvironmentSource> };
export function editorRows(declaration: TranslatorEnvironmentDeclaration,
  values?: { scope?: "global" | "game"; global?: unknown; game?: unknown }): TranslatorEnvironmentRow[];
export function launchValues(declarations: readonly TranslatorEnvironmentDeclaration[], ids: readonly string[],
  layers?: { global?: unknown; game?: unknown }): { values: Record<string, string>; translators: string[]; sources: Record<string, string> };
export function applyEnvironment<T extends Record<string, string | undefined>>(environment: T, values: Record<string, string>,
  options?: { required?: readonly string[] }): T & Record<string, string>;
