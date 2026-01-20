const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Patcher = require("../src/modules/shared/web/cheats/patcher");

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
