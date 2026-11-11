export function toolsOverrideAfterFailure(
  pending: { gamePath: string; failed: boolean | null } | null,
  record: { gamePath: string; moduleData?: Record<string, any> } | null | undefined
): boolean | null | undefined;
