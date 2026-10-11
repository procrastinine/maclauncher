const { parentPort } = require("node:worker_threads");
parentPort.on("message", message => {
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
  } else parentPort.postMessage({ type: "result", id: message.id, result: message.args });
});
