const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  normalizeRenpyAssetPath,
  resolveConfigValueFromRoots,
  resolveRenpyIconPath
} = require("../src/modules/renpy/options");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("resolveConfigValueFromRoots prefers earlier roots", () => {
  const rootA = makeTempDir("maclauncher-renpy-options-a-");
  const rootB = makeTempDir("maclauncher-renpy-options-b-");
  try {
    fs.writeFileSync(path.join(rootA, "options.rpy"), 'define config.save_directory = "First"');
    fs.writeFileSync(path.join(rootB, "options.rpy"), 'define config.save_directory = "Second"');
    const value = resolveConfigValueFromRoots([rootA, rootB], "save_directory");
    assert.equal(value, "First");
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test("normalizeRenpyAssetPath trims leading game segments", () => {
  assert.equal(normalizeRenpyAssetPath("game/gui/icon.png"), path.join("gui", "icon.png"));
  assert.equal(normalizeRenpyAssetPath("./gui/icon.png"), path.join("gui", "icon.png"));
});

test("resolveRenpyIconPath honors config values and fallbacks", () => {
  const root = makeTempDir("maclauncher-renpy-icon-");
  try {
    const guiDir = path.join(root, "gui");
    fs.mkdirSync(guiDir, { recursive: true });
    const iconPath = path.join(guiDir, "icon.png");
    fs.writeFileSync(iconPath, "png");
    const resolved = resolveRenpyIconPath([root], "gui/icon.png");
    assert.equal(resolved, iconPath);
    const fallback = resolveRenpyIconPath([root], null);
    assert.equal(fallback, iconPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRenpyIconPath keeps webp config paths for downstream cache conversion", () => {
  const root = makeTempDir("maclauncher-renpy-icon-");
  try {
    const guiDir = path.join(root, "gui");
    fs.mkdirSync(guiDir, { recursive: true });
    const webpPath = path.join(guiDir, "window_icon.webp");
    fs.writeFileSync(webpPath, "webp");
    const resolved = resolveRenpyIconPath([root], "gui/window_icon.webp");
    assert.equal(resolved, webpPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
