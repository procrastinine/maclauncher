const { randomUUID } = require("node:crypto");
const { createAbortError } = require("../modules/shared/runtime/download-utils");

// Renderer IDs are scoped to their initiating webContents. Only a private token
// crosses into a backend lane, so another window cannot cancel that operation.
function createModuleActionRequests({ request }) {
  const owners = new Map();
  function release(owner, requestId, record) {
    const state = owners.get(owner);
    if (!state || state.jobs.get(requestId) !== record) return;
    state.jobs.delete(requestId);
    if (state.jobs.size) return;
    owners.delete(owner);
    owner.removeListener("destroyed", state.closed);
    owner.removeListener("render-process-gone", state.closed);
  }
  function abort(record) {
    return record.aborting ||= Promise.resolve().then(() => request(record.lane, "cancelModuleAction", record.token));
  }
  async function run(owner, requestId, lane, args) {
    if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
      throw new Error("Invalid action request.");
    if (owner.isDestroyed()) throw createAbortError("The action window was closed.");
    let state = owners.get(owner);
    if (!state) {
      state = { jobs: new Map(), closed: () => {
        for (const record of state.jobs.values()) void abort(record).catch(() => {});
        for (const [id, record] of [...state.jobs]) release(owner, id, record);
      } };
      owners.set(owner, state);
      owner.once("destroyed", state.closed);
      owner.once("render-process-gone", state.closed);
    }
    if (state.jobs.has(requestId)) throw new Error("This action request is already running.");
    const record = { token: randomUUID(), lane };
    state.jobs.set(requestId, record);
    try { return await request(lane, "moduleAction", ...args, { requestId: record.token }); }
    finally { release(owner, requestId, record); }
  }
  function cancel(owner, requestId) {
    const record = owners.get(owner)?.jobs.get(requestId);
    return record ? abort(record) : Promise.resolve(false);
  }
  return { run, cancel };
}

module.exports = { createModuleActionRequests };
