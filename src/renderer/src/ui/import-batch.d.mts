// A game found in a subfolder of a folder that has none at its top level.
// Choices that select one game share its gamePath.
export type NestedGame = { inputPath: string; relativePath: string; gamePath: string; name: string; label?: string | null };
export type ImportFailure = { inputPath: string; reason: string; code?: string; nestedGames?: NestedGame[] };
export type ImportBatch = { total: number; completed: number; added: number; currentPath: string | null; failures: ImportFailure[] };
export function runImportBatch(paths: string[], add: (path: string) => Promise<unknown>, onProgress?: (batch: ImportBatch) => void): Promise<ImportBatch>;
export function resolveImportFailure(batch: ImportBatch, index: number, replacement: ImportBatch): ImportBatch;
