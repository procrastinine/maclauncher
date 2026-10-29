import type { ModuleManifest } from "./types";
export type DropGameTarget = { label: string; mono?: boolean };
export const graphicsDropTargets: readonly DropGameTarget[];
export function dropGameTargets(modules?: Pick<ModuleManifest, "detection">[]): DropGameTarget[];
