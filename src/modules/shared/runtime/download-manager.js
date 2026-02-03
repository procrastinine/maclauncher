const { createAbortError, isAbortError } = require("./download-utils");

let nextId = 1;

function normalizeText(value) {
  if (value == null) return "";
  const text = String(value).trim();
  return text;
}

function toPublicTask(task) {
  return {
    id: task.id,
    label: task.label,
    detail: task.detail || null,
    kind: task.kind || "download",
    managerId: task.managerId || null,
    sectionId: task.sectionId || null,
    version: task.version || null,
    variant: task.variant || null,
    downloaded: task.downloaded || 0,
    total: Number.isFinite(task.total) ? task.total : null,
    status: task.status,
    startedAt: task.startedAt || null,
    error: task.error || null
  };
}

class DownloadManager {
  constructor({ onChange, progressThrottleMs } = {}) {
    this.tasks = new Map();
    this.onChange = typeof onChange === "function" ? onChange : null;
    this.progressThrottleMs = Number.isFinite(progressThrottleMs)
      ? Math.max(0, progressThrottleMs)
      : 250;
    this._progressEmitTimer = null;
    this._lastProgressEmitAt = 0;
  }

  setOnChange(handler) {
    this.onChange = typeof handler === "function" ? handler : null;
  }

  emitChange() {
    try {
      this.onChange?.();
    } catch {}
  }

  emitProgressChange() {
    if (!this.onChange) return;
    const now = Date.now();
    const elapsed = now - this._lastProgressEmitAt;
    if (elapsed >= this.progressThrottleMs && !this._progressEmitTimer) {
      this._lastProgressEmitAt = now;
      this.emitChange();
      return;
    }
    if (this._progressEmitTimer) return;
    const wait = Math.max(0, this.progressThrottleMs - elapsed);
    this._progressEmitTimer = setTimeout(() => {
      this._progressEmitTimer = null;
      this._lastProgressEmitAt = Date.now();
      this.emitChange();
    }, wait);
  }

  list() {
    return Array.from(this.tasks.values()).map(toPublicTask);
  }

  runTask(meta, runner) {
    if (typeof runner !== "function") {
      throw new Error("Download task missing runner");
    }
    const label = normalizeText(meta?.label) || "Download";
    const detail = normalizeText(meta?.detail) || "";
    const kind = normalizeText(meta?.kind) || "download";
    const managerId = normalizeText(meta?.managerId) || "";
    const sectionId = normalizeText(meta?.sectionId) || "";
    const version = normalizeText(meta?.version) || "";
    const variant = normalizeText(meta?.variant) || "";
    const dedupeKey = normalizeText(meta?.dedupeKey) || "";

    if (dedupeKey) {
      for (const task of this.tasks.values()) {
        if (task.dedupeKey === dedupeKey && task.status === "downloading") {
          return task.promise;
        }
      }
    }

    const id = `dl_${Date.now()}_${nextId++}`;
    const controller = new AbortController();
    const task = {
      id,
      label,
      detail,
      kind,
      managerId: managerId || null,
      sectionId: sectionId || null,
      version: version || null,
      variant: variant || null,
      downloaded: 0,
      total: null,
      status: "downloading",
      error: null,
      startedAt: Date.now(),
      controller,
      dedupeKey: dedupeKey || null,
      promise: null
    };

    const updateProgress = patch => {
      if (!patch || typeof patch !== "object") return;
      if (task.status !== "downloading") return;
      const downloaded = Number(patch.downloaded);
      const total = Number(patch.total);
      let changed = false;
      if (Number.isFinite(downloaded) && downloaded !== task.downloaded) {
        task.downloaded = downloaded;
        changed = true;
      }
      if (Number.isFinite(total) || patch.total === null) {
        const nextTotal = Number.isFinite(total) ? total : null;
        if (nextTotal !== task.total) {
          task.total = nextTotal;
          changed = true;
        }
      }
      if (changed) this.emitProgressChange();
    };

    const runPromise = (async () => {
      try {
        const res = await runner({
          signal: controller.signal,
          onProgress: updateProgress,
          taskId: id
        });
        task.status = "done";
        return res;
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted) {
          task.status = "canceled";
          task.error = null;
        } else {
          task.status = "error";
          task.error = String(err?.message || err);
        }
        throw err;
      } finally {
        this.emitChange();
        this.tasks.delete(id);
        this.emitChange();
      }
    })();

    task.promise = runPromise;
    this.tasks.set(id, task);
    this.emitChange();
    return runPromise;
  }

  cancel(id) {
    const task = this.tasks.get(id);
    if (!task) return false;
    task.status = "canceled";
    try {
      task.controller?.abort(createAbortError());
    } catch {}
    this.emitChange();
    return true;
  }
}

function runDownloadTask(downloads, meta, runner, { onProgress } = {}) {
  if (!downloads || typeof downloads.runTask !== "function") {
    return runner({
      signal: null,
      onProgress: onProgress || null
    });
  }
  return downloads.runTask(meta, ({ signal, onProgress: taskProgress }) =>
    runner({
      signal,
      onProgress: progress => {
        try {
          taskProgress?.(progress);
        } catch {}
        try {
          onProgress?.(progress);
        } catch {}
      }
    })
  );
}

module.exports = {
  DownloadManager,
  runDownloadTask
};
