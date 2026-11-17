export type InstalledRuntimeAvailability = "installed" | "needsRepair" | "incompatible" | "unavailable";
export function installedRuntimeAvailability(row: unknown): InstalledRuntimeAvailability | null;
export function installedRuntimeReplaceable(row: unknown): boolean;
