// Each game has one current job and, if its inputs change during that job,
// one replacement. Selection moves pending work ahead of background work.
// A reserved lane lets selection start even while background lanes are busy.
function createLibraryWorkQueue({ run, concurrency = 3, defer = setImmediate } = {}) {
  const pending = new Map(), active = new Map();
  const lanes = new Set(Array.from({ length: concurrency }, (_, i) => `library-view:${i}`));
  let interactive = false, scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    defer(() => { scheduled = false; pump(); });
  }
  function pump() {
    for (const [id, job] of pending) {
      if (active.has(id)) continue;
      const lane = lanes.values().next().value || (job.priority && !interactive ? "library-view:selection" : null);
      if (!lane) continue;
      pending.delete(id);
      if (lane === "library-view:selection") interactive = true; else lanes.delete(lane);
      active.set(id, job);
      Promise.resolve().then(() => run(job.request, lane)).then(job.resolve, job.reject).finally(() => {
        active.delete(id);
        if (lane === "library-view:selection") interactive = false; else lanes.add(lane);
        schedule();
      });
    }
  }
  return {
    enqueue(request, { priority = false } = {}) {
      const { id, key } = request;
      const running = active.get(id);
      if (!pending.has(id) && running?.request.key === key && (!request.refreshMetadata || running.request.refreshMetadata)) return running.promise;
      let job = pending.get(id);
      if (job) job.request = { ...request, refreshMetadata: request.refreshMetadata || job.request.refreshMetadata };
      else {
        job = { request, priority: false };
        job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      }
      job.priority ||= priority;
      if (job.priority) {
        pending.delete(id);
        const rest = [...pending]; pending.clear(); pending.set(id, job);
        for (const row of rest) pending.set(...row);
      } else pending.set(id, job);
      schedule();
      return job.promise;
    },
    prioritize(id) {
      const job = pending.get(id);
      if (job) return this.enqueue(job.request, { priority: true });
      return active.get(id)?.promise;
    },
    retain(ids) { for (const [id, job] of pending) if (!ids.has(id)) { pending.delete(id); job.resolve(); } }
  };
}
module.exports = { createLibraryWorkQueue };
