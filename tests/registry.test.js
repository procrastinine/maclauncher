const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Modules = require("../src/modules/registry");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

test("findIndexHtml prefers package.json main", () => {
  const root = makeTempDir("maclauncher-index-");
  try {
    const htmlPath = path.join(root, "app", "index.html");
    writeFile(htmlPath, "<html></html>");
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ main: "app/index.html" })
    );

    const found = Modules.findIndexHtml(root);
    assert.equal(found, htmlPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findIndexHtml falls back to www/index.html", () => {
  const root = makeTempDir("maclauncher-www-");
  try {
    const htmlPath = path.join(root, "www", "index.html");
    writeFile(htmlPath, "<html></html>");

    const found = Modules.findIndexHtml(root);
    assert.equal(found, htmlPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame falls back to Web module for generic index.html", () => {
  const root = makeTempDir("maclauncher-web-");
  try {
    const htmlPath = path.join(root, "index.html");
    writeFile(htmlPath, "<html></html>");

    const detected = Modules.detectGame(root);
    assert.equal(detected.engine, "web");
    assert.equal(detected.gameType, "web");
    assert.equal(detected.indexHtml, htmlPath);
    assert.equal(detected.defaultSaveDir, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame prefers exe name over folder fallback", () => {
  const root = makeTempDir("maclauncher-web-exe-");
  try {
    writeFile(path.join(root, "index.html"), "<html></html>");
    writeFile(path.join(root, "CoolGame.exe"), "");

    const detected = Modules.detectGame(root);
    assert.equal(detected.engine, "web");
    assert.equal(detected.name, "CoolGame");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame app bundle error lists supported modules", () => {
  const root = makeTempDir("maclauncher-app-");
  const appPath = path.join(root, "Test.app");
  fs.mkdirSync(appPath, { recursive: true });

  try {
    assert.throws(
      () => Modules.detectGame(appPath),
      err => {
        const message = String(err?.message || "");
        if (!message.includes("Unsupported .app bundle")) return false;
        const labels = Modules.listSupportedModules();
        return labels.every(label => message.includes(label));
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("getModuleInfo returns an unknown placeholder", () => {
  const info = Modules.getModuleInfo("mystery");
  assert.equal(info.id, "mystery");
  assert.equal(info.label, "Unknown");
  assert.equal(info.supports?.cheats, false);
});
