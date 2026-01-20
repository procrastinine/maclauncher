const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const PluginTools = require("../src/modules/shared/mvmz/plugins");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

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
