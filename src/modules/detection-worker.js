const { parentPort, workerData } = require("node:worker_threads");
const { createDetectionSession } = require("./detection");

async function probe() {
  try {
    const session = createDetectionSession(workerData.inputPath, workerData.limits);
    for (const [filePath, value] of workerData.zip || []) session.caches.zip.set(filePath, value);
    for (const [filePath, value] of workerData.archive || []) session.caches.archive.set(filePath, value);
    const mod = require(workerData.modulePath);
    const detect = mod.detectGameAsync || mod.detectGame;
    const result = await detect(session.context, session.helpers);
    parentPort.postMessage({ result: result || null });
  } catch (error) {
    parentPort.postMessage({ error: String(error.message || error) });
  }
}

probe();
