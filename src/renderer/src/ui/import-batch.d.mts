export type ImportFailure = { inputPath: string; reason: string };
export type ImportBatch = { total: number; completed: number; added: number; currentPath: string | null; failures: ImportFailure[] };
export function runImportBatch(paths: string[], add: (path: string) => Promise<unknown>, onProgress?: (batch: ImportBatch) => void): Promise<ImportBatch>;
export function resolveImportFailure(batch: ImportBatch, index: number, replacement: ImportBatch): ImportBatch;
