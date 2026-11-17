import type { ImportBatch } from "./import-batch.mjs";
export type PendingImportRow = { inputPath: string; name: string; moduleId: string | null; phase: string; completed?: number; total?: number };
export function pendingImportRows(
  batches?: Pick<ImportBatch, "pendingPaths">[],
  jobs?: { inputPath: string; phase: string; name?: string; moduleId?: string; completed?: number; total?: number }[],
  games?: { gamePath: string; importPath?: string | null }[]
): PendingImportRow[];
