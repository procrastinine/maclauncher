const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Patcher = require("../src/modules/shared/web/cheats/patcher");
const Runtime = require("../src/modules/shared/mvmz/cheats/runtime");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

test("patchGame MV writes bootstrap with tools override", () => {
  const root = makeTempDir("maclauncher-mv-");
  try {
    const indexDir = root;
    const mainJs = path.join(indexDir, "js", "main.js");
    writeFile(mainJs, "PluginManager.setup($plugins);\n");

    const detected = { engine: "mv", indexDir };
    const status = Patcher.patchGame(detected, {
      toolsButtonVisible: false,
      appVersion: "test"
    });

    assert.equal(status.patched, true);

    const bootstrapPath = path.join(indexDir, "js", "plugins", "MacLauncher_Tools.js");
    const bootstrap = fs.readFileSync(bootstrapPath, "utf8");
    assert.match(bootstrap, /var TOOLS_BUTTON_OVERRIDE = false;/);

    const mainText = fs.readFileSync(mainJs, "utf8");
    assert.match(mainText, /maclauncher:cheats-patch/);

    const unpatched = Patcher.unpatchGame(detected);
    assert.equal(unpatched.patched, false);
    assert.equal(fs.existsSync(bootstrapPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MV/MZ tools list slicing defaults to larger scrollable batches", () => {
  const rows = Array.from({ length: 250 }, (_value, index) => index + 1);
  const helpers = Runtime.__test;

  assert.equal(helpers.TOOLS_LIST_INITIAL_LIMIT, 100);
  assert.equal(helpers.TOOLS_LIST_INCREMENT, 100);
  assert.equal(helpers.normalizeToolsListLimit(undefined), 100);
  assert.equal(helpers.normalizeToolsListLimit(0), 100);
  assert.equal(helpers.normalizeToolsListLimit("150"), 150);
  assert.equal(helpers.sliceToolsListRows(rows)[99], 100);
  assert.equal(helpers.sliceToolsListRows(rows, 175).length, 175);
});

test("MV/MZ tools source preserves focus for rerendered search fields", () => {
  const sourcePath = path.join(
    __dirname,
    "..",
    "src",
    "modules",
    "shared",
    "mvmz",
    "cheats",
    "runtime.js"
  );
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.match(source, /data-mcg-focus/);
  assert.match(source, /inventory-search/);
  assert.match(source, /teleport-search/);
  assert.match(source, /data-search/);
  assert.doesNotMatch(source, /shown\s*>=\s*30/);
  assert.doesNotMatch(source, /shown\s*>=\s*25/);
  assert.doesNotMatch(source, /out\.length\s*>=\s*30/);
});

test("patchGame MZ inserts tools bootstrap and can unpatch", () => {
  const root = makeTempDir("maclauncher-mz-");
  try {
    const indexDir = root;
    const mainJs = path.join(indexDir, "js", "main.js");
    writeFile(
      mainJs,
      ["const scriptUrls = [", '  "js/plugins.js",', "];", ""].join("\n")
    );

    const detected = { engine: "mz", indexDir };
    const status = Patcher.patchGame(detected, { appVersion: "test" });

    assert.equal(status.patched, true);

    const bootstrapPath = path.join(indexDir, "js", "plugins", "MacLauncher_Tools.js");
    const bootstrap = fs.readFileSync(bootstrapPath, "utf8");
    assert.match(bootstrap, /var TOOLS_BUTTON_OVERRIDE = null;/);

    const mainText = fs.readFileSync(mainJs, "utf8");
    assert.match(mainText, /js\/plugins\/MacLauncher_Tools\.js/);

    const unpatched = Patcher.unpatchGame(detected);
    assert.equal(unpatched.patched, false);

    const mainAfter = fs.readFileSync(mainJs, "utf8");
    assert.equal(mainAfter.includes("MacLauncher_Tools.js"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
