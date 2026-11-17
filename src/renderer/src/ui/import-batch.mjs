// Keep each selected input independent: a failed import never discards later inputs.
// Every input is handed to the launcher at once. Its import queue starts them in
// this order, a few at a time, so one slow game never holds up the rest. The
// batch reports the first input still in progress and every unfinished input.
export async function runImportBatch(paths, add, onProgress = () => {}) {
  const result = { total: paths.length, completed: 0, added: 0, currentPath: null, pendingPaths: [], failures: [] };
  const failures = new Array(paths.length), finished = new Array(paths.length).fill(false);
  const report = () => {
    result.pendingPaths = paths.filter((_, index) => !finished[index]);
    result.currentPath = result.pendingPaths[0] ?? null;
    result.failures = failures.filter(Boolean);
    onProgress({ ...result, pendingPaths: [...result.pendingPaths], failures: [...result.failures] });
  };
  report();
  await Promise.all(paths.map(async (inputPath, index) => {
    try {
      await add(inputPath);
      result.added++;
    } catch (error) {
      failures[index] = { inputPath, reason: String(error?.message || error), ...(typeof error?.code === "string" ? { code: error.code } : {}),
        ...(Array.isArray(error?.nestedGames) && error.nestedGames.length ? { nestedGames: error.nestedGames } : {}) };
    }
    finished[index] = true;
    result.completed++;
    report();
  }));
  return { ...result, pendingPaths: [], failures: failures.filter(Boolean) };
}

export function resolveImportFailure(batch, index, replacement) {
  return { ...batch, total: batch.total - 1 + replacement.total,
    completed: batch.completed - 1 + replacement.completed, added: batch.added + replacement.added,
    failures: [...batch.failures.slice(0, index), ...replacement.failures, ...batch.failures.slice(index + 1)] };
}
