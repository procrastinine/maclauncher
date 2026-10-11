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
  } else parentPort.postMessage({ type: "result", id: message.id, result: message.args });
});
