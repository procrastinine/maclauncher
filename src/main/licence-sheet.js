// A consent plan of kind "licence" is shown as a modal sheet on the launcher window,
// with the licence as read-only scrolling plain text. A message box grows with
// its text, so a full licence would put its buttons below the screen.
// The page runs without scripts and reports a choice only by navigating to
// `maclauncher-licence:agree` or `maclauncher-licence:cancel`, which the
// sheet intercepts and never loads.
const SCHEME = "maclauncher-licence:";

const escape = value => String(value ?? "").replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
// The accent is the system accent color, as RRGGBBAA, with the macOS blue otherwise.
function page(plan, accent = "007affff") {
  const color = /^[0-9a-f]{8}$/i.test(accent) ? `#${accent}` : "#007aff";
  const title = plan.title || `${plan.label || "Component"} license`;
  const subtitle = plan.component ? `Required to import ${plan.component}.` : plan.message || "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action ${SCHEME}">
<meta name="color-scheme" content="light dark"><title>${escape(plan.message || title)}</title>
<style>
:root { color-scheme: light dark; --accent: ${color}; --window: #ececec; --text: rgba(0,0,0,.85); --secondary: rgba(0,0,0,.5);
  --field: #fff; --border: rgba(0,0,0,.15); --button: #fff; --button-text: rgba(0,0,0,.85); }
@media (prefers-color-scheme: dark) { :root { --window: #323232; --text: rgba(255,255,255,.85); --secondary: rgba(255,255,255,.55);
  --field: #1e1e1e; --border: rgba(255,255,255,.12); --button: #656565; --button-text: rgba(255,255,255,.85); } }
html, body { height: 100%; margin: 0; }
body { box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; padding: 18px 20px 20px; background: var(--window);
  color: var(--text); font: 13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif; -webkit-user-select: none; cursor: default; }
h1 { margin: 0; font-size: 13px; font-weight: 600; }
p { margin: 3px 0 0; color: var(--secondary); font-size: 11px; }
.text { flex: 1; overflow: auto; margin: 0; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  background: var(--field); border: 1px solid var(--border); border-radius: 5px; -webkit-user-select: text; cursor: text; }
.text:focus { outline: none; }
.buttons { display: flex; justify-content: flex-end; gap: 12px; }
form { margin: 0; }
button { min-width: 82px; padding: 3px 12px; font: 13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif; color: var(--button-text);
  background: var(--button); border: 0; border-radius: 5px; box-shadow: 0 0 0 .5px rgba(0,0,0,.2), 0 1px 1px rgba(0,0,0,.12); }
button.default { color: #fff; background: var(--accent); }
button:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 50%, transparent); outline-offset: 0; }
</style></head><body>
<header><h1>${escape(title)}</h1>${subtitle ? `<p>${escape(subtitle)}</p>` : ""}</header>
<pre class="text" tabindex="0" aria-label="License text">${escape(String(plan.detail ?? "").trim())}</pre>
<div class="buttons">
<form action="${SCHEME}cancel"><button type="submit" class="default" autofocus>${escape(plan.cancelLabel || "Cancel")}</button></form>
<form action="${SCHEME}agree"><button type="submit">${escape(plan.confirmLabel || "Agree")}</button></form>
</div></body></html>`;
}

// Resolves to the consent contract of the runtime consent dialog: agreement
// for Agree, false for Cancel, Escape, closing the sheet or its parent, or a
// superseded request.
function show(plan, { parent, signal, electron = require("electron") } = {}) {
  const { BrowserWindow, nativeTheme, systemPreferences } = electron;
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    const sheet = new BrowserWindow({ ...(parent && !parent.isDestroyed?.() ? { parent, modal: true } : {}), show: false,
      width: 620, height: 560, minWidth: 420, minHeight: 300, resizable: true, minimizable: false, maximizable: false, fullscreenable: false,
      title: plan.message || "License", backgroundColor: nativeTheme?.shouldUseDarkColors ? "#323232" : "#ececec",
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, spellcheck: false, devTools: false } });
    const finish = agreed => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", abort);
      resolve(agreed ? plan.licenseRequired ? { approved: true, licenseAccepted: true } : true : false);
      if (!sheet.isDestroyed()) sheet.close();
    };
    const abort = () => finish(false);
    signal?.addEventListener?.("abort", abort, { once: true });
    sheet.on("closed", () => finish(false));
    const contents = sheet.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      event.preventDefault();
      const choice = String(url).startsWith(SCHEME) ? String(url).slice(SCHEME.length).replace(/[?#].*$/, "") : "";
      if (choice === "agree" || choice === "cancel") finish(choice === "agree");
    });
    contents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && (input.key === "Escape" || (input.meta && input.key === "."))) { event.preventDefault(); finish(false); }
    });
    sheet.once("ready-to-show", () => { if (!settled) sheet.show(); });
    let accent;
    try { accent = systemPreferences?.getAccentColor?.(); } catch {}
    sheet.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(plan, accent))}`).catch(() => finish(false));
  });
}

module.exports = { show, page };
