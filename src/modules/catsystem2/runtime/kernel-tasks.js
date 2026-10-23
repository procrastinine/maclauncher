const Encoding = require("../encoding"), { inspectKernelScript } = require("../kernel-script");
const { KernelMachine } = require("./kernel-vm"), { createKernelServices } = require("./kernel-services");
const { LIMITS: QUEUE } = require("./message-queue");
const LIMITS = Object.freeze({ tasks: 128, frames: 1000000, nameBytes: 255 });
const MESSAGES = Object.freeze({ shutdown: 0xffff0006, resetMessageWindow: 0xffff0012 });

/** Authored child KCS tasks with distinct stacks and the original shared region. */
function createKernelTasks({ engineVersion, registry, tasks, rootHost, frontEnd, serviceOptions = {}, signal, trace } = {}) {
  if (engineVersion !== "2.6.1.76" || !registry?.read || !tasks?.create || !tasks.lookup || !tasks.remove || !rootHost?.memory ||
      !rootHost.state || !frontEnd?.load || !frontEnd.start || !frontEnd.dispose || !frontEnd.setLocal)
    throw new Error("This CatSystem2 child script version is unsupported.");
  const records = new Map(); let lastFrame = -1, inFrame = false, closed = false;
  function get(id) { const item = records.get(id); if (!item) throw new Error("The KCS child task handle is absent."); return item; }
  function name(value) {
    if (typeof value !== "string" || !value || /[\x00-\x1f]/.test(value) || Encoding.encode(value).length > LIMITS.nameBytes)
      throw new Error("The KCS child script name exceeds its range."); return value;
  }
  async function load(id, source, { parentFrontEnd = null, onExitCode } = {}) {
    signal?.throwIfAborted(); if (closed || records.size >= LIMITS.tasks || records.has(id)) throw new Error("KCS child tasks exceed their session limit.");
    const task = tasks.lookup(id, "kernel");
    if (task.id === rootHost.state.taskId) throw new Error("The root KCS program cannot be replaced by a child script.");
    if (parentFrontEnd != null) tasks.lookup(parentFrontEnd, "front-end");
    const sourceName = name(source), program = await inspectKernelScript(await registry.read("kcs", sourceName, { maximumBytes: 16 * 1024 * 1024 }));
    const item = { id, task, name: sourceName, parentFrontEnd, screens: new Set(), machine: null, host: null, closing: false };
    const childFrontEnd = {
      load: async (screenId, screenName) => {
        if (tasks.lookup(screenId, "front-end").parent !== id) throw new Error("The KCS child screen belongs to a different task.");
        await frontEnd.load(screenId, screenName, parentFrontEnd, { notifyParent: false }); item.screens.add(screenId);
      },
      start: screenId => frontEnd.start(screenId), setLocal: (...args) => frontEnd.setLocal(...args),
      getLocal: (...args) => { if (!frontEnd.getLocal) throw new Error("KCS front-end locals are unavailable."); return frontEnd.getLocal(...args); },
      callBlock: (...args) => { if (!frontEnd.callBlock) throw new Error("KCS front-end callbacks are unavailable."); return frontEnd.callBlock(...args); },
      dispose: async screenId => { await frontEnd.dispose(screenId); item.screens.delete(screenId); }
    };
    item.host = createKernelServices({ ...serviceOptions, engineVersion, taskId: id, taskRegistry: tasks, frontEnd: childFrontEnd,
      externalBytes: rootHost.memory.bytes.length, sharedMemory: rootHost.memory, sharedState: rootHost.state,
      getFrame: () => Math.max(0, lastFrame),
      getPointer: frontEnd.getPointer ? () => frontEnd.getPointer() : serviceOptions.getPointer,
      onExitCode: async code => { trace?.({ type: "kernel-exit", id, code }); await onExitCode?.(code); } });
    item.machine = new KernelMachine(program, { nativeCalls: item.host.nativeCalls, externalMemory: item.host.externalMemory, signal });
    records.set(id, item);
    try { await item.machine.run(); trace?.({ type: "kernel-loaded", id, name: sourceName, parentFrontEnd }); return item; }
    catch (error) {
      records.delete(id);
      for (const screenId of [...item.screens]) if (frontEnd.scripts?.has(screenId)) await frontEnd.dispose(screenId);
      item.host.close();
      throw error;
    }
  }
  async function create({ parentId, name: source, onExitCode } = {}) {
    const parent = tasks.lookup(parentId, "front-end"), task = tasks.create(12, parent.id, name(source));
    // The load handler makes the program runnable. Focus/lifecycle records
    // must come from their actual host transition rather than child creation.
    try { return await load(task.id, source, { parentFrontEnd: parent.id, onExitCode }); }
    catch (error) { if (records.has(task.id)) await remove(task.id); else tasks.remove(task.id); throw error; }
  }
  async function remove(id) {
    const item = get(id); signal?.throwIfAborted();
    if (item.closing) throw new Error("KCS child task removal is already running."); item.closing = true;
    try {
      if (!item.machine.halted) {
        if (item.machine.suspended?.kind !== "message") throw new Error("The KCS child task cannot receive its shutdown event.");
        item.host.messages.enqueue([0xffffffff, MESSAGES.shutdown, 0, 0]);
        while (item.host.messages.deliver(item.machine)) await item.machine.run();
      }
      for (const screenId of [...item.screens]) if (frontEnd.scripts?.has(screenId)) await frontEnd.dispose(screenId);
      item.host.close(); records.delete(id); tasks.remove(id); trace?.({ type: "kernel-removed", id });
    } finally { item.closing = false; }
  }
  async function tick(frame) {
    signal?.throwIfAborted();
    if (closed || inFrame || !Number.isSafeInteger(frame) || frame !== lastFrame + 1 || frame > LIMITS.frames)
      throw new Error("KCS child frame sequence is invalid.");
    inFrame = true; lastFrame = frame;
    try {
      for (const item of [...records.values()]) {
        if (records.get(item.id) !== item || item.closing || item.machine.halted) continue;
        if (item.machine.suspended?.kind !== "message") throw new Error("The KCS child task requires an unsupported continuation.");
        if (!item.host.messages.deliver(item.machine)) item.machine.resumeFrame();
        await item.machine.run();
      }
    } finally { inFrame = false; }
  }
  function resetMessageWindow() {
    signal?.throwIfAborted(); if (closed) throw new Error("The KCS session has closed.");
    const queues = [rootHost.messages, ...[...records.values()].filter(item => !item.closing && !item.machine.halted).map(item => item.host.messages)];
    if (queues.some(queue => !queue?.enqueue || !Number.isInteger(queue.size))) throw new Error("KCS window-message delivery is unavailable.");
    if (queues.some(queue => queue.size >= QUEUE.messages)) throw new Error("The KCS message queue exceeds its limit.");
    // Window menu13 broadcasts native message20 from the host. The KCS task
    // receiver queues its established four-word record for the script itself.
    for (const queue of queues) queue.enqueue([0, MESSAGES.resetMessageWindow, 0, 0]);
  }
  async function close() { if (closed) return; for (const id of [...records.keys()].reverse()) if (records.has(id)) await remove(id); closed = true; }
  return { records, get, load, create, remove, tick, close, resetMessageWindow };
}
module.exports = { LIMITS, MESSAGES, createKernelTasks };
