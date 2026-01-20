// maclauncher:nwjs-patched-loader.js
(() => {
  try {
    if (globalThis.__maclauncher_patchedLoaded) return;
    globalThis.__maclauncher_patchedLoaded = true;
  } catch {}

  const fs = require("fs");
  const path = require("path");
  const { pathToFileURL } = require("url");

  const startPath = (() => {
    try {
      if (typeof nw !== "undefined" && nw?.App?.startPath) return nw.App.startPath;
    } catch {}
    try {
      return process.cwd();
    } catch {}
    return "";
  })();

  const manifest = (() => {
    try {
      return typeof nw !== "undefined" && nw?.App?.manifest ? nw.App.manifest : null;
    } catch {
      return null;
    }
  })();

  const resolveFromStart = rel => {
    if (!rel || typeof rel !== "string") return null;
    const cleaned = rel.replace(/^\.\/+/, "");
    return startPath ? path.join(startPath, cleaned) : cleaned;
  };

  const configPath =
    manifest?.maclauncher?.patchedConfigPath
      ? resolveFromStart(manifest.maclauncher.patchedConfigPath)
      : resolveFromStart("__maclauncher/nwjs-patched/patch.json");

  let config = null;
  try {
    if (configPath && fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
  } catch {}
  if (!config || typeof config !== "object") return;

  const runtimeRoot = resolveFromStart(config.runtimeRoot || "__maclauncher/nwjs-patched") || "";
  const kawarikiRoot = path.join(runtimeRoot, "kawariki");

  const parseSemver = input => {
    const raw = String(input || "").trim().replace(/^v/i, "");
    const match = raw.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };

  const compareSemver = (a, b) => {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (!pa || !pb) return 0;
    for (let i = 0; i < 3; i += 1) {
      const diff = pa[i] - pb[i];
      if (diff !== 0) return diff;
    }
    return 0;
  };

  const resolveEsTag = () => {
    const nwVersion = String(process?.versions?.nw || "");
    const supportsEs13 = compareSemver(nwVersion, "0.57.0") >= 0;
    return supportsEs13 ? "es13" : "es5";
  };

  const esTag = resolveEsTag();
  const esRoot = path.join(kawarikiRoot, esTag);
  const importMap = {
    imports: {
      "$kawariki:es-polyfill": pathToFileURL(path.join(esRoot, `${esTag}-polyfill.mjs`)).toString(),
      "$kawariki:es/": pathToFileURL(`${esRoot}${path.sep}`).toString()
    }
  };

  const modules = Array.isArray(config.modules)
    ? config.modules.map(m => String(m || "").trim()).filter(Boolean)
    : [];
  const scripts = Array.isArray(config.scripts)
    ? config.scripts.map(s => String(s || "").trim()).filter(Boolean)
    : [];

  const scriptParent = (() => {
    try {
      return document?.head || document?.documentElement || document?.body || null;
    } catch {
      return null;
    }
  })();

  const appendScript = (attrs, onload, onerror) => {
    if (!scriptParent || !attrs) return null;
    const el = document.createElement("script");
    el.async = false;
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null) continue;
      el[key] = value;
    }
    if (onload) el.addEventListener("load", onload);
    if (onerror) el.addEventListener("error", onerror);
    scriptParent.appendChild(el);
    return el;
  };

  const ensureImportMap = () => {
    if (!modules.length) return;
    appendScript({
      type: "importmap",
      textContent: JSON.stringify(importMap)
    });
  };

  const resolveScriptUrl = value => {
    if (!value) return null;
    if (value.startsWith("file://")) return value;
    const candidate = path.isAbsolute(value)
      ? value
      : path.join(kawarikiRoot, value);
    return pathToFileURL(candidate).toString();
  };

  const resolveModuleSpec = value => {
    if (!value) return null;
    if (value.startsWith("$kawariki:") || value.startsWith("file:")) return value;
    return `$kawariki:es/${value}`;
  };

  const loadScripts = () => {
    for (const script of scripts) {
      const url = resolveScriptUrl(script);
      if (!url) continue;
      appendScript({ src: url, type: "text/javascript" });
    }
  };

  const ensureSystemJs = () => new Promise(resolve => {
    if (globalThis.System && typeof globalThis.System.import === "function") {
      resolve(globalThis.System);
      return;
    }
    const url = pathToFileURL(path.join(esRoot, "s.js")).toString();
    appendScript({ src: url, type: "text/javascript" }, () => resolve(globalThis.System), () => resolve(null));
  });

  const dynamicImport = (() => {
    try {
      return new Function("spec", "return import(spec);");
    } catch {
      return null;
    }
  })();

  const loadModules = async () => {
    if (!modules.length) return;
    ensureImportMap();

    if (esTag === "es13") {
      if (!dynamicImport) return;
      const promises = modules
        .map(resolveModuleSpec)
        .filter(Boolean)
        .map(spec => dynamicImport(spec));
      await Promise.allSettled(promises);
      return;
    }

    const System = await ensureSystemJs();
    if (!System || typeof System.import !== "function") return;
    if (typeof System.addImportMap === "function") {
      System.addImportMap(importMap);
    }
    const promises = modules
      .map(resolveModuleSpec)
      .filter(Boolean)
      .map(spec => System.import(spec));
    await Promise.allSettled(promises);
  };

  const loadUserScripts = async () => {
    if (!config.enableUserScripts) return;
    const root = config.userScriptRoot
      ? path.resolve(String(config.userScriptRoot))
      : startPath;
    if (!root) return;

    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }

    const jsFiles = [];
    const mjsFiles = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name || "";
      if (name.endsWith(".maclauncher.js")) jsFiles.push(path.join(root, name));
      if (name.endsWith(".maclauncher.mjs")) mjsFiles.push(path.join(root, name));
    }

    for (const file of jsFiles) {
      try {
        require(file);
      } catch (e) {
        console.warn("[MacLauncher] User script failed:", file, e);
      }
    }

    if (!mjsFiles.length || !dynamicImport) return;
    const promises = mjsFiles.map(file => dynamicImport(pathToFileURL(file).toString()));
    await Promise.allSettled(promises);
  };

  loadScripts();
  loadModules().finally(() => {
    loadUserScripts();
  });
})();
