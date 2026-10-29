const crypto = require("node:crypto");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { DapTransport } = require("./dap");
const Symbols = require("./debug-symbols");

const sessions = new Map();
const endedSessions = new Map();
const pendingStarts = new Map();
const gameKey = (entry, userDataDir) => {
  if (!entry?.gameId || !path.isAbsolute(userDataDir || "")) throw new Error("Import this game before opening live variables.");
  return `${path.resolve(userDataDir)}\0${entry.gameId}`;
};

// The runtime's catalog entry declares its debug adapter. This adapter speaks
// DAP with NUL-terminated messages.
function resolveAdapter(runtime) {
  if (runtime?.debugAdapter !== "dap-terminal-nul-v1") throw new Error("Live variables require an xsystem35 runtime with its debug adapter.");
  return { terminalNul: true };
}

class LiveVariablesSession extends EventEmitter {
  constructor({ child, runtime, prepared, adapter = resolveAdapter(runtime), requestTimeout = 10000 }) {
    super();
    this.id = crypto.randomUUID();
    this.child = child;
    this.runtime = runtime;
    this.prepared = prepared;
    this.transport = new DapTransport(child, { terminalNul: adapter.terminalNul, timeout: requestTimeout });
    this.phase = "starting";
    this.scopes = [];
    this.queue = Promise.resolve();
    this.transport.on("event", event => {
      if (event.event === "stopped") { this.phase = "paused"; this.reason = event.body?.reason || "pause"; this.emit("state", this.getState()); }
    });
    this.transport.on("closed", error => {
      if (this.phase !== "exited") {
        this.phase = "unavailable";
        this.reason = error.message;
        // End-of-input releases the reviewed native adapter's wait loop. It
        // must never leave a running game paused after its editor is lost.
        if (child.exitCode == null && child.signalCode == null) child.stdin.end?.();
      }
      this.emit("state", this.getState());
    });
    child.once("exit", (code, signal) => {
      this.phase = "exited";
      this.exitCode = code;
      this.signal = signal;
      this.emit("state", this.getState());
      this.emit("exit");
    });
  }

  getState() {
    return { sessionId: this.id, phase: this.phase, reason: this.reason || null, pid: this.child.pid,
      runtimeId: "xsystem35", runtimeVersion: this.runtime.runtimeVersion,
      scopes: this.scopes.map(scope => ({ id: scope.variablesReference === 1 ? "globals" : "strings",
        label: scope.variablesReference === 1 ? "Variables" : "Strings", count: scope.namedVariables ?? scope.indexedVariables ?? 0 })),
      exitCode: this.exitCode ?? null, signal: this.signal || null };
  }

  serial(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async initialize() {
    await this.transport.request("initialize", { clientID: "maclauncher", adapterID: "xsystem35", locale: "en", supportsVariablePaging: true });
    await this.transport.request("launch", { stopOnEntry: true });
    await Promise.all([this.transport.waitFor("stopped"), this.transport.request("configurationDone")]);
    const body = await this.transport.request("scopes", { frameId: 0 });
    this.scopes = body.scopes || [];
    this.phase = "paused";
    return this.getState();
  }

  assertPaused() {
    if (this.phase !== "paused") throw new Error(this.phase === "running" ? "Pause the game to inspect or change live variables." : "This live-variable session is unavailable.");
  }

  pause() {
    return this.serial(async () => {
      if (this.phase === "paused") return this.getState();
      if (this.phase !== "running") throw new Error("This live-variable session is unavailable.");
      await Promise.all([this.transport.waitFor("stopped"), this.transport.request("pause", { threadId: 1 })]);
      this.phase = "paused";
      const body = await this.transport.request("scopes", { frameId: 0 });
      this.scopes = body.scopes || [];
      return this.getState();
    });
  }

  resume() {
    return this.serial(async () => {
      if (this.phase === "running" || this.phase === "exited") return this.getState();
      this.assertPaused();
      await this.transport.request("continue", { threadId: 1 });
      if (this.phase !== "exited" && !this.transport.closed) { this.phase = "running"; this.reason = null; }
      return this.getState();
    });
  }

  list({ scope = "globals", start = 0, count = 128 } = {}) {
    return this.serial(async () => {
      this.assertPaused();
      if (!["globals", "strings"].includes(scope) || !Number.isSafeInteger(start) || start < 0 ||
          !Number.isSafeInteger(count) || count < 1 || count > 256) throw new Error("Choose a variable scope and a page of up to 256 entries.");
      const reference = scope === "globals" ? 1 : 2;
      const selected = this.scopes.find(row => row.variablesReference === reference);
      const total = selected?.namedVariables ?? selected?.indexedVariables ?? 0;
      if (start > total) throw new Error("Variable page is outside this scope.");
      const body = await this.transport.request("variables", { variablesReference: reference, start, count });
      return { ...this.getState(), scope, start, count, total, variables: (body.variables || []).map((row, offset) => ({
        index: start + offset, name: row.name, value: row.value,
        type: scope === "globals" ? "integer" : "string", editable: scope === "strings" || /^\d+$/.test(row.value || "")
      })) };
    });
  }

  set({ scope = "globals", index, value } = {}) {
    return this.serial(async () => {
      this.assertPaused();
      if (!["globals", "strings"].includes(scope) || !Number.isSafeInteger(index) || index < 0) throw new Error("Choose a valid variable index.");
      const reference = scope === "globals" ? 1 : 2;
      const selected = this.scopes.find(row => row.variablesReference === reference);
      const total = selected?.namedVariables ?? selected?.indexedVariables ?? 0;
      if (index >= total) throw new Error("Variable index is outside this scope.");
      let nativeValue;
      if (scope === "globals") {
        const input = String(value);
        if (!/^\d{1,5}$/.test(input) || Number(input) > 65535) throw new Error("Variable value must be an integer from 0 to 65535.");
        nativeValue = String(Number(input));
      } else {
        if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 4096) throw new Error("String value must be text of at most 4096 UTF-8 bytes without NUL.");
        // Native setVariable removes only its surrounding quotation marks;
        // the DAP JSON transport performs all necessary string escaping.
        nativeValue = `"${value}"`;
      }
      const before = await this.transport.request("variables", { variablesReference: reference, start: index, count: 1 });
      const variable = before.variables?.[0];
      if (!variable || !variable.name || scope === "globals" && !/^\d+$/.test(variable.value || "")) throw new Error("This variable is unavailable for editing.");
      await this.transport.request("setVariable", { variablesReference: reference, name: variable.name, value: nativeValue });
      const after = await this.transport.request("variables", { variablesReference: reference, start: index, count: 1 });
      if (!after.variables?.[0]) throw new Error("The native runtime did not return the changed variable.");
      return { ...this.getState(), scope, index, name: variable.name, previousValue: variable.value, value: after.variables[0].value };
    });
  }

  // Closing an editor leaves its game playing. Keep the protocol transport
  // alive and drained until native exit; DAP disconnect would exit the game.
  closeEditor() { return ["exited", "unavailable"].includes(this.phase) ? Promise.resolve(this.getState()) : this.resume(); }

  stop() {
    return this.serial(async () => {
      if (this.phase === "exited") return this.getState();
      const exited = new Promise(resolve => this.child.once("exit", resolve));
      try { await this.transport.request("disconnect", { terminateDebuggee: true }); }
      catch (error) {
        if (this.child.exitCode == null && this.child.signalCode == null) this.child.kill("SIGTERM");
      }
      const timer = setTimeout(() => { if (this.child.exitCode == null && this.child.signalCode == null) this.child.kill("SIGKILL"); }, 2000);
      await exited;
      clearTimeout(timer);
      return this.getState();
    });
  }
}

async function startSession({ entry, userDataDir, runtime, scenarioPath, spawn, requestTimeout }) {
  const key = gameKey(entry, userDataDir);
  if (sessions.has(key)) return sessions.get(key);
  if (pendingStarts.has(key)) return pendingStarts.get(key);
  const pending = (async () => {
    if (sessions.size + pendingStarts.size >= 8) throw new Error("Close an existing live-variable game before starting another.");
    const adapter = resolveAdapter(runtime);
    const prepared = Symbols.prepareDebugDirectory({ entry, userDataDir, scenarioPath });
    const child = await spawn(prepared.directory);
    let session;
    try {
      session = new LiveVariablesSession({ child, runtime, prepared, adapter, requestTimeout });
      sessions.set(key, session);
      session.once("exit", () => {
        if (sessions.get(key) === session) sessions.delete(key);
        endedSessions.delete(key);
        endedSessions.set(key, session.getState());
        while (endedSessions.size > 32) endedSessions.delete(endedSessions.keys().next().value);
      });
      await session.initialize();
      return session;
    } catch (error) {
      if (session) await session.stop().catch(() => {});
      else child.kill?.("SIGTERM");
      sessions.delete(key);
      throw error;
    }
  })();
  pendingStarts.set(key, pending);
  try { return await pending; }
  finally { pendingStarts.delete(key); }
}

function getSession(entry, context, payload = {}) {
  const session = sessions.get(gameKey(entry, context?.userDataDir));
  if (!session || payload.sessionId && payload.sessionId !== session.id) throw new Error("This live-variable session has ended.");
  return session;
}

function findSession(entry, context) { return sessions.get(gameKey(entry, context?.userDataDir)) || null; }

function getSessionState(entry, context, payload = {}) {
  const key = gameKey(entry, context?.userDataDir), id = payload?.sessionId;
  if (id !== undefined && (typeof id !== "string" || !id || id.length > 128 || id.includes("\0"))) throw new Error("Choose a valid live-variable session.");
  const session = sessions.get(key);
  if (session && (!id || id === session.id)) return session.getState();
  const ended = endedSessions.get(key);
  if (ended && (!id || id === ended.sessionId)) return { ...ended, scopes: ended.scopes.map(scope => ({ ...scope })) };
  return { sessionId: id || null, phase: "unavailable", reason: "This live-variable session has ended.",
    pid: null, runtimeId: "xsystem35", runtimeVersion: null, scopes: [], exitCode: null, signal: null };
}

function closeEditor(entry, context, payload = {}) {
  const state = getSessionState(entry, context, payload);
  if (["exited", "unavailable"].includes(state.phase)) return Promise.resolve(state);
  return getSession(entry, context, payload).closeEditor();
}

module.exports = { resolveAdapter, LiveVariablesSession, startSession, getSession, findSession, getSessionState, closeEditor };
