export const MAX_RUNTIME_CHOICE_LENGTH: number;
export function isRuntimeSettingChoiceValue(value: unknown): value is string;
type Field = { type?: string; default?: unknown; listSeparator?: "newline"; optionsAction?: string;
  options?: Array<{ value?: unknown; id?: unknown }>; legacyValues?: Array<{ value: unknown; replacement: string }> };
export function resolveRuntimeSettingFallback(field: Field): unknown;
export function normalizeListValue(value: unknown, separator?: "newline"): string[];
export function normalizeRuntimeSettingValue(field: Field, value: unknown, fallback: unknown): string | number | boolean | string[];
