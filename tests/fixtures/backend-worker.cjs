const { parentPort, workerData } = require("node:worker_threads");
parentPort.on("message", async message => {
  if (message.type === "callbackResult") {
    parentPort.postMessage({ type: "result", id: message.id, result: message.result, error: message.error }); return;
  }
  if (message.type !== "request") return;
  if (message.method === "busy") {
    parentPort.postMessage({ type: "event", event: "entered", payload: {} });
    const end = performance.now() + message.args[0];
    while (performance.now() < end) {} // Deliberately models synchronous runtime hashing.
    parentPort.postMessage({ type: "result", id: message.id, result: true });
  } else if (message.method === "callback") {
    parentPort.postMessage({ type: "callback", id: message.id, method: "choose", args: message.args });
  } else if (message.method === "finishedProcess") {
    const process = { id: "early-exit", pid: 12345, exitCode: 0 };
    parentPort.postMessage({ type: "event", event: "process", payload: { process, event: "exit", code: 0 } });
    parentPort.postMessage({ type: "result", id: message.id, result: process });
  } else if (message.method === "inspectorProcess" || message.method === "delayedInspectorProcess") {
    const launch = () => {
    const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    child.unref();
    const record = { id: String(message.id), pid: child.pid };
    parentPort.postMessage({ type: "event", event: "toolProcess", payload: { process: record, stopOnLauncherExit: message.args[0] === true } });
    child.once("close", (code, signal) => parentPort.postMessage({ type: "event", event: "process", payload: { process: record, event: "close", code, signal } }));
    parentPort.postMessage({ type: "result", id: message.id, result: record });
    };
    if (message.method === "delayedInspectorProcess") setTimeout(launch, message.args[1] || 100);
    else launch();
  } else if (message.method === "runtimeToolRoles") {
    try {
      const { createBackendOperations } = require("../../src/core/backend-operations");
      const { once } = require("node:events"), path = require("node:path");
      const gamePath = message.args[0], descriptors = message.args[1], pids = [];
      const info = { id: "web", label: "Fixture", gameType: "native",
        runtime: { default: "runner", supported: ["runner"], entries: { runner: {} } } };
      const mod = { id: info.id, manifest: info, actions: { inspect: async (_entry, _payload, context) => {
        for (const descriptor of descriptors) {
          const child = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30)"], { stdio: "ignore" });
          const closed = once(child, "close"); pids.push(child.pid);
          await context.onToolProcessSpawn(child, Object.freeze({ ...descriptor, command: "/private/executable", environment: { TOKEN: "private" } }));
          await closed;
        }
        return pids;
      } } };
      const registry = { listModuleIds: () => [info.id], listModules: () => [info], getModule: () => mod, getModuleInfo: () => info,
        getModuleDir: () => path.dirname(gamePath), listSharedRuntimeManagers: () => [], getRuntimeManagerUi: () => null,
        detectGameAsync: async () => ({ moduleId: info.id, gamePath, contentRootDir: gamePath, name: "Fixture" }) };
      const operations = createBackendOperations({ userDataDir: workerData.userDataDir, registry,
        emit: (event, payload) => parentPort.postMessage({ type: "event", event, payload }) });
      const entry = await operations.importEntry(gamePath, {});
      entry.runtimeId = "runner";
      require("../../src/core/game-store").writeGameRecord(workerData.userDataDir, entry);
      const result = await operations.moduleAction(entry, "inspect", {}, {});
      parentPort.postMessage({ type: "result", id: message.id, result: { pids: result, gameId: entry.gameId } });
    } catch (error) {
      parentPort.postMessage({ type: "result", id: message.id, error: require("../../src/core/backend-worker-client").errorRecord(error) });
    }
  } else parentPort.postMessage({ type: "result", id: message.id, result: message.args });
});
