import type { ModuleManifest } from "./types";
export type DropGameTarget = { label: string; mono?: boolean };
export function dropGameTargets(modules?: Pick<ModuleManifest, "detection">[]): DropGameTarget[];
