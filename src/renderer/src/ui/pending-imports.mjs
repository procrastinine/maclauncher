// Every requested import has a library row from the moment it is requested.
// The row first shows the item's own name, then the title and game type that
// detection reports, and it leaves when the game's record arrives in the
// library or the import ends. Batches started in this window list their items
// before the launcher has received them; imports started elsewhere (the File
// menu, Finder, a store download) come from the launcher's import queue.
const itemName = inputPath => inputPath.split(/[\\/]/).filter(Boolean).pop() || inputPath;

export function pendingImportRows(batches = [], jobs = [], games = []) {
  const added = new Set(games.flatMap(game => [game.gamePath, game.importPath].filter(Boolean)));
  const progress = new Map(jobs.map(job => [job.inputPath, job]));
  const rows = [], listed = new Set();
  const add = (inputPath, job) => {
    if (!inputPath || listed.has(inputPath) || added.has(inputPath)) return;
    listed.add(inputPath);
    rows.push({ inputPath, name: job?.name || itemName(inputPath), moduleId: job?.moduleId || null, phase: job?.phase || "queued",
      ...(job?.total > 0 ? { completed: Math.min(job.completed || 0, job.total), total: job.total } : {}) });
  };
  for (const batch of batches) for (const inputPath of batch.pendingPaths || []) add(inputPath, progress.get(inputPath));
  for (const job of jobs) add(job.inputPath, job);
  return rows;
}
