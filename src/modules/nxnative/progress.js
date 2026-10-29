function count(value) { return Number.isFinite(value) && value >= 0 ? value : undefined; }
function text(value, limit = 512) { return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, limit) : undefined; }

// The NSP builder's JSON events are the frontend interface; host logs are diagnostic text.
function createProgressHandler(report) {
  let current = { phase: "prepare", label: "Preparing game…" };
  return event => {
    if (!event || !["stage", "step", "progress", "stage_end", "say"].includes(event.ev)) return;
    if (event.ev === "say") {
      const message = text(event.msg);
      if (!message) return;
      current = { ...current, message };
    } else {
      if (typeof event.name !== "string") return;
      if (event.ev === "stage" || event.ev === "step") current = { phase: "prepare", label: "Preparing game…",
        ...(event.ev === "step" ? { stageTotal: current.stageTotal } : {}) };
      const name = text(event.name), step = text(event.step, 128);
      const label = /shader split/i.test(name) ? "Finding shaders…"
        : /shader/i.test(name) && /cache/i.test(step || "") ? "Checking shaders…"
        : /shader/i.test(name) && /translat/i.test(step || "") ? "Translating shaders…"
        : /shader/i.test(name) ? "Preparing shaders…" : /extract/i.test(name) ? "Extracting game…"
        : /rewrite/i.test(name) ? "Converting game…" : "Preparing game…";
      current = { ...current, label, stage: name, ...(step === undefined ? {} : { step }),
        stageIndex: count(event.k), ...(count(event.n) === undefined ? {} : { stageTotal: event.n }) };
      if (event.ev === "progress") {
        const completed = count(event.done), total = count(event.total), fraction = count(event.frac);
        current = { ...current, completed, total: total > 0 ? total : undefined, estimated: event.est === true,
          unit: text(event.unit, 32), note: text(event.note), elapsed: count(event.elapsed), eta: count(event.eta),
          percent: fraction === undefined ? completed !== undefined && total > 0 && !event.est
            ? Math.min(99, completed / total * 100) : undefined : Math.min(99, fraction * 100) };
      } else if (event.ev === "stage_end") {
        current = { ...current, stageComplete: event.ok === true, percent: event.ok === true ? 100 : undefined,
          completed: undefined, total: undefined, eta: undefined, message: text(event.summary), elapsed: count(event.elapsed) };
      }
    }
    report?.({ ...current });
  };
}
module.exports = { createProgressHandler };
