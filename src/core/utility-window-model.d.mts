export type UtilityWindowKind = "settings" | "runtimes" | "credits" | "external";
export type UtilityWindowRequest = { view: UtilityWindowKind; managerId?: string; sectionId?: string };
export type UtilityWindowContext = UtilityWindowRequest & { revision?: number };
export function normalizeUtilityWindowRequest(value: unknown): UtilityWindowRequest;
export function utilityWindowDefinition(view: string | null): {
  title: string; width: number; height: number; minWidth: number; minHeight: number;
} | null;
export function readUtilityWindowContext(search: string): UtilityWindowRequest | null;
