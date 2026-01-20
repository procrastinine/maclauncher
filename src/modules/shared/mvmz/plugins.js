const fs = require("node:fs");
const path = require("node:path");

const PLUGINS = {
  clipboard: {
    id: "clipboard",
    entryName: "Clipboard_llule",
    fileName: "Clipboard_llule.js",
    label: "Clipboard text hooker",
    description: "Clipboard text hooker"
  },
  saveSlots: {
    id: "saveSlots",
    entryName: "CustomizeMaxSaveFile",
    fileName: "CustomizeMaxSaveFile.js",
    label: "500 save slots",
    description: "500 save slots"
  }
};

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function detectNewline(text) {
  return String(text || "").includes("\r\n") ? "\r\n" : "\n";
}

function findPluginsArraySource(raw) {
  const text = String(raw || "");
  const assignMatch = text.match(/(?:var|let|const)\s+\$plugins\s*=/);
  if (!assignMatch || assignMatch.index == null) {
    throw new Error("plugins.js missing $plugins array");
  }
  const searchFrom = assignMatch.index + assignMatch[0].length;
  const start = text.indexOf("[", searchFrom);
  if (start < 0) {
    throw new Error("plugins.js missing $plugins array");
  }

  let depth = 0;
  let inString = false;
  let stringQuote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === stringQuote) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }

    if (ch === "\"" || ch === "'") {
      inString = true;
      stringQuote = ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === "[") {
      depth++;
      continue;
    }
    if (ch === "]") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  throw new Error("plugins.js $plugins array not closed");
}

function resolvePluginAsset(plugin) {
  return path.resolve(__dirname, "plugins", plugin.fileName);
}

function resolvePaths(indexDir, plugin) {
  const pluginsDir = path.join(indexDir, "js", "plugins");
  const pluginsFilePath = path.join(indexDir, "js", "plugins.js");
  const pluginPath = path.join(pluginsDir, plugin.fileName);
  const maclauncherDir = path.join(pluginsDir, "maclauncher");
  const metaPath = path.join(maclauncherDir, `${plugin.id}.maclauncher.json`);
  return {
    pluginsDir,
    pluginsFilePath,
    pluginPath,
    maclauncherDir,
    metaPath
  };
}

function readPluginsFile(pluginsPath) {
  if (!existsFile(pluginsPath)) {
    throw new Error(`plugins.js not found: ${pluginsPath}`);
  }
  const raw = fs.readFileSync(pluginsPath, "utf8").replace(/^\uFEFF/, "");
  const newline = detectNewline(raw);
  const source = findPluginsArraySource(raw);
  const list = JSON.parse(source);
  if (!Array.isArray(list)) {
    throw new Error("plugins.js $plugins is not an array");
  }
  return { list, newline };
}

function writePluginsFile(pluginsPath, list, newline) {
  const json = JSON.stringify(list, null, 2).replace(/\n/g, newline);
  const out = `var $plugins = ${json};${newline}`;
  fs.writeFileSync(pluginsPath, out, "utf8");
}

function getPlugin(id) {
  return PLUGINS[id] || null;
}

function listPlugins() {
  return Object.values(PLUGINS);
}

function ensurePluginEntry(list, plugin, enabled) {
  const status = enabled !== false;
  const entry = list.find(item => item && item.name === plugin.entryName);
  if (entry) {
    entry.status = status;
    if (typeof entry.description !== "string") {
      entry.description = plugin.description;
    }
    if (!entry.parameters || typeof entry.parameters !== "object") {
      entry.parameters = {};
    }
    return list;
  }
  list.push({
    name: plugin.entryName,
    status,
    description: plugin.description,
    parameters: {}
  });
  return list;
}

function removePluginEntry(list, plugin) {
  return list.filter(item => !item || item.name !== plugin.entryName);
}

function getStatus(indexDir, pluginId) {
  const plugin = getPlugin(pluginId);
  if (!plugin) throw new Error(`Unknown plugin id: ${pluginId}`);
  const paths = resolvePaths(indexDir, plugin);
  const fileExists = existsFile(paths.pluginPath);
  const metaExists = existsFile(paths.metaPath);
  let entryExists = false;
  try {
    const { list } = readPluginsFile(paths.pluginsFilePath);
    entryExists = list.some(item => item && item.name === plugin.entryName);
  } catch {
    entryExists = false;
  }
  return {
    pluginId: plugin.id,
    entryName: plugin.entryName,
    fileExists,
    entryExists,
    managed: metaExists,
    installed: Boolean(fileExists && entryExists)
  };
}

function getAllStatus(indexDir) {
  const status = {};
  for (const plugin of listPlugins()) {
    status[plugin.id] = getStatus(indexDir, plugin.id);
  }
  return status;
}

function installPlugin(indexDir, pluginId, { logger } = {}) {
  const plugin = getPlugin(pluginId);
  if (!plugin) throw new Error(`Unknown plugin id: ${pluginId}`);
  const paths = resolvePaths(indexDir, plugin);
  const assetPath = resolvePluginAsset(plugin);
  if (!existsFile(assetPath)) {
    throw new Error(`Missing bundled plugin asset: ${plugin.fileName}`);
  }

  ensureDir(paths.pluginsDir);
  const fileExists = existsFile(paths.pluginPath);
  const metaExists = existsFile(paths.metaPath);
  if (!fileExists || metaExists) {
    fs.copyFileSync(assetPath, paths.pluginPath);
  } else {
    logger?.warn?.(
      `[mvmz-plugins] ${plugin.entryName} already exists; leaving existing file intact`
    );
  }

  const { list, newline } = readPluginsFile(paths.pluginsFilePath);
  ensurePluginEntry(list, plugin, true);
  writePluginsFile(paths.pluginsFilePath, list, newline);

  if (!fileExists || metaExists) {
    ensureDir(paths.maclauncherDir);
    fs.writeFileSync(
      paths.metaPath,
      JSON.stringify(
        {
          installedBy: "maclauncher",
          pluginId: plugin.id,
          installedAt: Date.now()
        },
        null,
        2
      ),
      "utf8"
    );
  }

  logger?.info?.(`[mvmz-plugins] installed ${plugin.entryName}`);
  return getStatus(indexDir, pluginId);
}

function removePlugin(indexDir, pluginId, { logger } = {}) {
  const plugin = getPlugin(pluginId);
  if (!plugin) throw new Error(`Unknown plugin id: ${pluginId}`);
  const paths = resolvePaths(indexDir, plugin);

  if (existsFile(paths.pluginsFilePath)) {
    const { list, newline } = readPluginsFile(paths.pluginsFilePath);
    const next = removePluginEntry(list, plugin);
    if (next.length !== list.length) {
      writePluginsFile(paths.pluginsFilePath, next, newline);
    }
  }

  if (existsFile(paths.metaPath)) {
    safeRm(paths.pluginPath);
    safeRm(paths.metaPath);
    try {
      if (fs.existsSync(paths.maclauncherDir) && fs.readdirSync(paths.maclauncherDir).length === 0) {
        fs.rmdirSync(paths.maclauncherDir);
      }
    } catch {}
  }

  logger?.info?.(`[mvmz-plugins] removed ${plugin.entryName}`);
  return getStatus(indexDir, pluginId);
}

module.exports = {
  PLUGIN_IDS: {
    clipboard: "clipboard",
    saveSlots: "saveSlots"
  },
  listPlugins,
  getStatus,
  getAllStatus,
  installPlugin,
  removePlugin
};
