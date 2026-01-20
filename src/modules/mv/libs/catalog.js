const fs = require("node:fs");
const path = require("node:path");

const MV_PIXI5_PATHS = [
  path.resolve(
    __dirname,
    "../../..",
    "external",
    "rpgmakermlinux-cicpoffs",
    "nwjs",
    "packagefiles",
    "rpgmaker-mv-pixi5"
  ),
  path.resolve(
    __dirname,
    "../../..",
    "external",
    "rpgmakermlinux-cicpoffs",
    "nwjs",
    "nwjs",
    "packagefiles",
    "rpgmaker-mv-pixi5"
  )
];

function pickFirstExistingDir(candidates) {
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {}
  }
  return candidates[0];
}

const MV_PIXI5_ROOT = pickFirstExistingDir(MV_PIXI5_PATHS);

const MV_PIXI5_FILES = [
  "js/rpg_core.js",
  "js/rpg_managers.js",
  "js/rpg_objects.js",
  "js/rpg_scenes.js",
  "js/rpg_sprites.js",
  "js/rpg_windows.js",
  "js/libs/fpsmeter.js",
  "js/libs/iphone-inline-video.browser.js",
  "js/libs/lz-string.js",
  "js/libs/pixi.js",
  "js/libs/pixi.js.map",
  "js/libs/pixi.min.js",
  "js/libs/pixi.min.js.map",
  "js/libs/pixi-legacy.js",
  "js/libs/pixi-legacy.js.map",
  "js/libs/pixi-legacy.min.js",
  "js/libs/pixi-legacy.min.js.map",
  "js/libs/pixi-picture.js",
  "js/libs/pixi-tilemap.js"
];

const DEPENDENCIES = [
  {
    id: "mv-pixi",
    label: "PixiJS",
    engine: "mv",
    description: "Renderer stack for RPG Maker MV.",
    versions: [
      {
        id: "pixi5-cicpoffs",
        label: "5.3.8 (MV 1.6.2.x patch)",
        summary: "PixiJS 5.3.8 with MV core updates from rpgmaker-linux (cicpoffs).",
        bundleRoot: MV_PIXI5_ROOT,
        files: MV_PIXI5_FILES,
        engineVersion: "1.6.2.2",
        notes: [
          "Based on RPG Maker MV 1.6.2.2.",
          "Includes MV core file replacements and updated Pixi tilemap/picture.",
          "ShaderTilemap may fall back to Tilemap."
        ],
        source: "rpgmaker-linux cicpoffs"
      }
    ]
  }
];

function cloneVersion(version) {
  return {
    ...version,
    files: Array.isArray(version.files) ? version.files.slice() : []
  };
}

function cloneDependency(dep) {
  return {
    ...dep,
    versions: Array.isArray(dep.versions) ? dep.versions.map(cloneVersion) : []
  };
}

function listDependencies() {
  return DEPENDENCIES.map(cloneDependency);
}

function getDependency(id) {
  return DEPENDENCIES.find(dep => dep.id === id) || null;
}

function getVersion(depId, versionId) {
  const dep = getDependency(depId);
  if (!dep) return null;
  return dep.versions.find(v => v.id === versionId) || null;
}

function resolveBundleFilePath(version, relPath) {
  return path.join(version.bundleRoot, relPath);
}

function listFilesForEngine(engine) {
  const out = new Set();
  for (const dep of DEPENDENCIES) {
    if (dep.engine !== engine) continue;
    for (const version of dep.versions || []) {
      for (const file of version.files || []) {
        out.add(file);
      }
    }
  }
  return Array.from(out);
}

module.exports = {
  getDependency,
  getVersion,
  listDependencies,
  listFilesForEngine,
  resolveBundleFilePath
};
