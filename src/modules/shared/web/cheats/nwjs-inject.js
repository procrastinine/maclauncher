// maclauncher:nwjs-inject.js
(() => {
  try {
    if (window.__maclauncher_cheatsInjected) return;
    window.__maclauncher_cheatsInjected = true;
  } catch {}

  const env = (() => {
    const out = {
      cheatsFilePath: null,
      logPath: null,
      fs: null,
      path: null,
      startPath: null
    };
    try {
      out.fs = require("fs");
      out.path = require("path");
    } catch {}
    try {
      const p =
        typeof nw !== "undefined" && nw?.App?.manifest?.maclauncher
          ? nw.App.manifest.maclauncher.cheatsFilePath
          : null;
      out.cheatsFilePath = typeof p === "string" && p ? p : null;
    } catch {}
    try {
      const p = typeof nw !== "undefined" && nw?.App ? nw.App.startPath : null;
      out.startPath = typeof p === "string" && p ? p : null;
    } catch {}
    try {
      if (out.cheatsFilePath) out.logPath = `${out.cheatsFilePath}.nwjs.log`;
      else if (out.path && typeof process?.cwd === "function") out.logPath = out.path.join(process.cwd(), "maclauncher-nwjs-inject.log");
    } catch {}
    return out;
  })();

  const logLine = msg => {
    try {
      if (!env.fs || !env.logPath) return;
      env.fs.appendFileSync(env.logPath, `[${new Date().toISOString()}] ${String(msg || "")}\n`, "utf8");
    } catch {}
  };

  const showFatalBadge = text => {
    try {
      if (!document?.body) return;
      if (document.getElementById("maclauncher-inject-badge")) return;
      const el = document.createElement("div");
      el.id = "maclauncher-inject-badge";
      el.textContent = String(text || "MacLauncher inject failed");
      el.style.cssText = [
        "position:fixed",
        "top:10px",
        "right:10px",
        "z-index:2147483647",
        "pointer-events:none",
        "padding:8px 10px",
        "border-radius:10px",
        "border:1px solid rgba(255,93,93,.55)",
        "background:rgba(15,23,36,.92)",
        "color:#e6e9ef",
        "font:12px/1.25 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial",
        "box-shadow:0 12px 32px rgba(0,0,0,.35)"
      ].join(";");
      document.body.appendChild(el);
    } catch {}
  };

  logLine("inject start");
  try { logLine(`href=${location.href}`); } catch {}
  try { logLine(`cwd=${typeof process?.cwd === "function" ? process.cwd() : ""}`); } catch {}
  try { logLine(`startPath=${String(env.startPath || "")}`); } catch {}
  try { logLine(`cheatsFilePath=${String(env.cheatsFilePath || "")}`); } catch {}
  try { logLine(`logPath=${String(env.logPath || "")}`); } catch {}
  try { logLine(`docURL=${String(document?.URL || "")}`); } catch {}
  try { logLine(`docEqWinDoc=${String(Boolean(window && document && window.document === document))}`); } catch {}

  const isTypingElementActive = () => {
    try {
      const el = document.activeElement;
      if (!(el instanceof Element)) return false;
      const tag = String(el.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      if (el.isContentEditable) return true;
    } catch {}
    return false;
  };

  const stopHotkey = e => {
    try {
      e.preventDefault();
      e.stopImmediatePropagation?.();
      e.stopPropagation();
    } catch {}
  };

  const requestToolsToggle = () => {
    try {
      const root = document.getElementById("maclauncher-tools");
      if (root) {
        const open = root.classList.contains("open");
        const handle = root.querySelector(".handle");
        const closeBtn = root.querySelector(".close");
        if (open) closeBtn?.dispatchEvent?.(new MouseEvent("click", { bubbles: true }));
        else handle?.dispatchEvent?.(new MouseEvent("click", { bubbles: true }));
        return;
      }
    } catch {}

    try {
      window.__maclauncher_toolsPendingOpen = !window.__maclauncher_toolsPendingOpen;
    } catch {}
    try {
      window.dispatchEvent(new Event("maclauncher:toggleTools"));
    } catch {}
  };

  try {
    window.addEventListener(
      "keydown",
      e => {
        const key = String(e.key || "");
        const isTyping = isTypingElementActive();
        if (isTyping) return;
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const code = String(e.code || "");
        if (key !== "1" && code !== "Digit1" && code !== "Numpad1" && e.keyCode !== 49 && e.keyCode !== 97) return;
        stopHotkey(e);
        requestToolsToggle();
      },
      true
    );
  } catch {}

  try {
    const path = require("path");

    const findMaclauncherRoot = () => {
      const fs = env.fs;
      if (!fs || !env.path) return null;

      const seen = new Set();
      const roots = [];
      const addRoot = p => {
        try {
          if (typeof p !== "string" || !p) return;
          const r = env.path.resolve(p);
          if (seen.has(r)) return;
          seen.add(r);
          roots.push(r);
        } catch {}
      };

      addRoot(env.startPath);
      try { addRoot(process.cwd()); } catch {}
      try {
        const href = String(location?.href || "");
        if (href.startsWith("file:")) {
          const u = new URL(href);
          const dir = env.path.dirname(decodeURIComponent(u.pathname));
          addRoot(dir);
        }
      } catch {}

      for (const base of roots) {
        let current = base;
        for (let i = 0; i < 6; i++) {
          try {
            const runtimePath = env.path.join(current, "__maclauncher", "runtime.js");
            const cheatsPath = env.path.join(current, "__maclauncher", "cheats.js");
            if (fs.existsSync(runtimePath) && fs.existsSync(cheatsPath)) return current;
          } catch {}
          const parent = env.path.dirname(current);
          if (!parent || parent === current) break;
          current = parent;
        }
      }

      return null;
    };

    const tryRequire = request => {
      try {
        return require(request);
      } catch {
        return null;
      }
    };

    const requireFirst = (candidates, label) => {
      for (const c of candidates) {
        const mod = tryRequire(c);
        if (mod) return mod;
      }
      throw new Error(`Unable to load ${label} from: ${candidates.join(", ")}`);
    };

    const cheatsCandidates = ["./cheats.js", "./__maclauncher/cheats.js"];
    const runtimeCandidates = ["./runtime.js", "./__maclauncher/runtime.js"];
    const root = findMaclauncherRoot();
    if (root) {
      cheatsCandidates.unshift(path.join(root, "__maclauncher", "cheats.js"));
      runtimeCandidates.unshift(path.join(root, "__maclauncher", "runtime.js"));
    }
    try {
      cheatsCandidates.push(path.join(process.cwd(), "__maclauncher", "cheats.js"));
      runtimeCandidates.push(path.join(process.cwd(), "__maclauncher", "runtime.js"));
    } catch {}
    try {
      if (env.startPath) {
        cheatsCandidates.push(path.join(env.startPath, "__maclauncher", "cheats.js"));
        runtimeCandidates.push(path.join(env.startPath, "__maclauncher", "runtime.js"));
      }
    } catch {}

    logLine(`cheatsCandidates=${cheatsCandidates.join(",")}`);
    logLine(`runtimeCandidates=${runtimeCandidates.join(",")}`);
    logLine(`resolvedRoot=${String(root || "")}`);

    const Cheats = requireFirst(cheatsCandidates, "cheats");
    const CheatsRuntime = requireFirst(runtimeCandidates, "runtime");

    const cheatsFilePath = env.cheatsFilePath;
    let toolsButtonVisible = true;
    try {
      const v =
        typeof nw !== "undefined" && nw?.App?.manifest?.maclauncher
          ? nw.App.manifest.maclauncher.toolsButtonVisible
          : null;
      if (v === false) toolsButtonVisible = false;
    } catch {}

    if (!CheatsRuntime || typeof CheatsRuntime.installCheatsRuntime !== "function") {
      throw new Error("Invalid cheat runtime module");
    }

    logLine("installCheatsRuntime begin");
    CheatsRuntime.installCheatsRuntime({
      window: window,
      document: document,
      DEFAULT_CHEATS: Cheats.DEFAULT_CHEATS,
      normalizeCheats: Cheats.normalizeCheats,
      cheatsFilePath,
      toolsButtonVisible,
      enableFileSync: true,
      enablePatcher: true,
      enableToolsUi: true
    });
    logLine("installCheatsRuntime ok");
  } catch (e) {
    logLine(`inject failed: ${String(e?.stack || e?.message || e)}`);
    // eslint-disable-next-line no-console
    console.error("[MacLauncher] NW.js cheat inject failed:", e);
    try {
      if (document?.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", () => showFatalBadge("MacLauncher tools failed to load"), { once: true });
      } else {
        showFatalBadge("MacLauncher tools failed to load");
      }
    } catch {}
  }
})();
