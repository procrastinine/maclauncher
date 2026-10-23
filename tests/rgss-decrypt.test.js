const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { resolveArchivePath } = require("../src/modules/rgss/decrypt");

function withTempDir(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rgss-decrypt-"));
  try {
    return fn(root);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
}

test("resolveArchivePath prefers the rgss version extension", () =>
  withTempDir(root => {
    fs.writeFileSync(path.join(root, "Game.rgssad"), "x");
    fs.writeFileSync(path.join(root, "Game.rgss3a"), "x");

    const entry = { contentRootDir: root, moduleData: { rgssVersion: "RGSS3" } };
    const resolved = resolveArchivePath(entry);
    assert.equal(path.basename(resolved), "Game.rgss3a");
  }));

test("resolveArchivePath returns null when no archives exist", () =>
  withTempDir(root => {
    const entry = { contentRootDir: root, moduleData: { rgssVersion: "RGSS2" } };
    const resolved = resolveArchivePath(entry);
    assert.equal(resolved, null);
  }));

test("resolveArchivePath searches recursively for rgss archives", () =>
  withTempDir(root => {
    const nestedDir = path.join(root, "data");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, "Game.rgss2a"), "x");

    const entry = { contentRootDir: root, moduleData: { rgssVersion: "RGSS2" } };
    const resolved = resolveArchivePath(entry);
    assert.equal(resolved, path.join(nestedDir, "Game.rgss2a"));
  }));
