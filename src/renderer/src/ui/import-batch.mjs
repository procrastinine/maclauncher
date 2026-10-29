// Keep each selected input independent: a failed import never discards later inputs.
export async function runImportBatch(paths, add, onProgress = () => {}) {
  const result = { total: paths.length, completed: 0, added: 0, currentPath: null, failures: [] };
  for (const inputPath of paths) {
    result.currentPath = inputPath;
    onProgress({ ...result, failures: [...result.failures] });
    try {
      await add(inputPath);
      result.added++;
    } catch (error) {
      result.failures.push({ inputPath, reason: String(error?.message || error) });
    }
    result.completed++;
  }
  result.currentPath = null;
  onProgress({ ...result, failures: [...result.failures] });
  return result;
}

export function resolveImportFailure(batch, index, replacement) {
  return { ...batch, total: batch.total - 1 + replacement.total,
    completed: batch.completed - 1 + replacement.completed, added: batch.added + replacement.added,
    failures: [...batch.failures.slice(0, index), ...replacement.failures, ...batch.failures.slice(index + 1)] };
}
