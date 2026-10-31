const path = require("node:path");
const { userImportError } = require("./import-error");

// A Finder event can arrive before Electron is ready, so imports wait for the
// importer. Imports then start in arrival order, a few at a time: a slow one,
// such as an installer waiting for a download, never holds up the others.
// The importer reads and writes the library in one synchronous step after its
// asynchronous detection, so concurrent imports never overwrite each other.
function createGameImportQueue({ onChange, cancelImporter, concurrency = 3 } = {}) {
  let importer;
  let start;
  const ready = new Promise(resolve => { start = resolve; });
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  const waiting = [];
  let active = 0;
  const pump = () => { while (active < limit && waiting.length) { active++; waiting.shift()(); } };
  const slot = () => new Promise(resolve => { waiting.push(resolve); pump(); });
  const release = () => { active--; pump(); };
  const pending = new Map();
  const jobs = new Map();
  const list = () => [...jobs.values()].filter(job => !job.cancelled).map(job => ({ inputPath: job.inputPath, phase: job.phase }));
  const changed = () => onChange?.(list());
  return {
    setImporter(handler, options = {}) {
      if (importer || typeof handler !== "function") throw new Error("Game importer must be configured once.");
      if (typeof options.onChange === "function") onChange = options.onChange;
      if (typeof options.cancelImporter === "function") cancelImporter = options.cancelImporter;
      importer = handler;
      start();
      changed();
    },
    import(input, options = {}) {
      if (typeof input !== "string" || !input.trim() || input.includes("\0")) {
        return Promise.reject(new Error("Choose a game file or folder."));
      }
      const resolved = path.resolve(input);
      if (pending.has(resolved)) return pending.get(resolved);
      const job = { inputPath: resolved, phase: "queued", cancelled: false };
      jobs.set(resolved, job);
      const operation = ready.then(slot).then(async () => {
        try {
          if (job.cancelled) throw Object.assign(new Error("Import cancelled."), { name: "AbortError", code: "ABORT_ERR" });
          job.phase = "processing"; changed();
          return await importer(resolved, options);
        } finally { release(); }
      }).catch(error => { throw userImportError(error, resolved); });
      pending.set(resolved, operation);
      const settled = () => {
        if (pending.get(resolved) === operation) pending.delete(resolved);
        if (jobs.get(resolved) === job) jobs.delete(resolved);
        changed();
      };
      operation.then(settled, settled);
      changed();
      return operation;
    },
    list,
    async cancel(input) {
      if (typeof input !== "string" || !input || input.includes("\0")) return false;
      const resolved = path.resolve(input), job = jobs.get(resolved);
      if (!job || job.cancelled) return false;
      if (job.phase === "queued") { job.cancelled = true; pending.delete(resolved); jobs.delete(resolved); changed(); return true; }
      return Boolean(await cancelImporter?.(resolved));
    }
  };
}

module.exports = { createGameImportQueue };
