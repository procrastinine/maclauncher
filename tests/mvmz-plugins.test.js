const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const PLUGIN_TOOLS_PATH = "../src/modules/shared/mvmz/plugins";
const PluginTools = require(PLUGIN_TOOLS_PATH);

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function reloadPluginTools() {
  delete require.cache[require.resolve(PLUGIN_TOOLS_PATH)];
  return require(PLUGIN_TOOLS_PATH);
}

test("installPlugin prefers packaged external cicpoffs plugin assets when available", () => {
  const originalResourcesPath = process.resourcesPath;
  const resourcesRoot = makeTempDir("maclauncher-mvmz-plugin-resources-");
  const root = makeTempDir("maclauncher-mvmz-plugins-");
  try {
    const externalPluginPath = path.join(
      resourcesRoot,
      "external",
      "rpgmakermlinux-cicpoffs",
      "nwjs",
      "packagefiles",
      "filestoexport",
      "plugins",
      "Clipboard_llule.js"
    );
    writeFile(externalPluginPath, "// external clipboard plugin marker\n");
    writeFile(path.join(root, "js", "plugins.js"), "var $plugins = [];\n");

    process.resourcesPath = resourcesRoot;
    const pluginTools = reloadPluginTools();
    pluginTools.installPlugin(root, pluginTools.PLUGIN_IDS.clipboard);

    const installedPath = path.join(root, "js", "plugins", "Clipboard_llule.js");
    const installedRaw = fs.readFileSync(installedPath, "utf8");
    assert.equal(installedRaw, "// external clipboard plugin marker\n");
  } finally {
    if (originalResourcesPath === undefined) {
      delete process.resourcesPath;
    } else {
      process.resourcesPath = originalResourcesPath;
    }
    reloadPluginTools();
    fs.rmSync(resourcesRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installPlugin and removePlugin manage plugins.js and files", () => {
  const root = makeTempDir("maclauncher-mvmz-plugins-");
  try {
    const pluginsFile = path.join(root, "js", "plugins.js");
    writeFile(pluginsFile, "var $plugins = [];\n");

    const installed = PluginTools.installPlugin(
      root,
      PluginTools.PLUGIN_IDS.clipboard
    );
    assert.equal(installed.installed, true);
    assert.ok(
      fs.existsSync(path.join(root, "js", "plugins", "Clipboard_llule.js"))
    );
    assert.ok(
      fs.existsSync(
        path.join(root, "js", "plugins", "maclauncher", "clipboard.maclauncher.json")
      )
    );

    const removed = PluginTools.removePlugin(
      root,
      PluginTools.PLUGIN_IDS.clipboard
    );
    assert.equal(removed.installed, false);
    assert.ok(
      !fs.existsSync(path.join(root, "js", "plugins", "Clipboard_llule.js"))
    );
    assert.ok(
      !fs.existsSync(
        path.join(root, "js", "plugins", "maclauncher", "clipboard.maclauncher.json")
      )
    );

    const raw = fs.readFileSync(pluginsFile, "utf8");
    assert.ok(!raw.includes("Clipboard_llule"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installPlugin tolerates plugins.js with string data containing ];", () => {
  const root = makeTempDir("maclauncher-mvmz-plugins-");
  try {
    const pluginsFile = path.join(root, "js", "plugins.js");
    writeFile(
      pluginsFile,
      [
        "var $plugins = [",
        "  {",
        "    \"name\": \"Example\",",
        "    \"status\": true,",
        "    \"description\": \"Contains ]; inside\",",
        "    \"parameters\": {",
        "      \"script\": \"console.log('ok');\"",
        "    }",
        "  }",
        "];",
        ""
      ].join("\n")
    );

    const installed = PluginTools.installPlugin(
      root,
      PluginTools.PLUGIN_IDS.saveSlots
    );
    assert.equal(installed.installed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
