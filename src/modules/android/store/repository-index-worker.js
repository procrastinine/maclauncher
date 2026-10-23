const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");

try {
  const stat = fs.statSync(workerData.file);
  if (stat.size > 160 * 1024 * 1024) throw Error("Repository index is too large.");
  const index = JSON.parse(fs.readFileSync(workerData.file, "utf8"));
  const app = index.packages?.[workerData.packageName];
  if (!app) parentPort.postMessage({ result: null });
  else {
    const metadata = app.metadata || {};
    parentPort.postMessage({ result: { metadata: { name: metadata.name, summary: metadata.summary, icon: metadata.icon, license: metadata.license, sourceCode: metadata.sourceCode, preferredSigner: metadata.preferredSigner },
      versions: Object.fromEntries(Object.entries(app.versions || {}).map(([id, value]) => [id, { added: value.added, file: value.file, manifest: { versionCode: value.manifest?.versionCode, versionName: value.manifest?.versionName, nativecode: value.manifest?.nativecode, usesSdk: value.manifest?.usesSdk, maxSdkVersion: value.manifest?.maxSdkVersion, signer: value.manifest?.signer } }])) } });
  }
} catch { parentPort.postMessage({ error: "The repository index could not be read." }); }
