const fs = require("node:fs");
const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const Catalog = require("./catalog");

const DEFAULT_VERSION = "0.8.1.1";
const PIN = { version: DEFAULT_VERSION, upstreamRevision: "78328fa29f465315291e161130e6682f69410370",
  upstreamTag: DEFAULT_VERSION, localBuild: false, minimumMacOS: "11.0",
  asset: { ...Catalog.archiveIdentity(DEFAULT_VERSION), bytes: 13814322,
    sha256: "3e0fdcc388797fd9117aa6b1fc3b1d93dbb457b7102abfe8227d6822543aba93",
    integritySource: "reviewed-sha256" } };

function resolveExecutable(root) {
  const direct = path.join(root, "EasyRPG Player.app");
  if (fs.existsSync(direct)) return direct;
  const app = fs.readdirSync(root, { withFileTypes: true }).find(item => item.isDirectory() && /\.app$/i.test(item.name));
  if (app) return path.join(root, app.name);
  throw new Error("The EasyRPG release does not contain a Mac app bundle.");
}

function createManager(dependencies = {}) {
  return createPinnedNativeManager({ id: "easyrpg", label: "EasyRPG Player", sourceUrl: Catalog.SOURCE_URL,
    catalog: [PIN], recommendedVersion: DEFAULT_VERSION, discoverCatalog: Catalog.createDiscovery(dependencies),
    validateRecordedArtifact: Catalog.validateRecordedArtifact, resolveExecutable, dependencies });
}

const manager = createManager();
manager.createManager = createManager;
manager.DEFAULT_VERSION = DEFAULT_VERSION;
manager.PIN = PIN;
module.exports = manager;
