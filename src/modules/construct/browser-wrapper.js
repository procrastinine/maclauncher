const fs = require("node:fs");
const path = require("node:path");

const FRAME_ID = "maclauncher-browser-content";
const HOST = "__maclauncher/construct-browser.html";
function configuration(entry, shimSource) {
  const root = entry?.contentRootDir || entry?.gamePath;
  if (!root || !entry?.indexHtml || typeof shimSource !== "string") return null;
  let manifest;
  try {
    const file = path.join(root, "package.json"), stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 256 * 1024) return null;
    manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return null; }
  if (manifest?.settings?.["content-mode"] !== "bundle" || manifest.settings["distribution-mode"] !== "evergreen") return null;
  const relative = path.relative(root, entry.indexHtml);
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes("..")) throw new Error("The browser export must remain within its content folder.");
  const framePath = relative.split(path.sep).join("/");
  const frameUrl = path.posix.relative(path.posix.dirname(HOST), framePath).split("/").map(encodeURIComponent).join("/");
  const title = String(entry.name || manifest.window?.title || manifest.name || "Game")
    .replace(/[&<>"']/g, character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[character]);
  const source = `(() => {
  const owner = nw.Window.get();
  const frame = document.createElement("iframe");
  frame.id = ${JSON.stringify(FRAME_ID)};
  frame.setAttribute("nwdisable", "");
  frame.setAttribute("allowfullscreen", "");
  frame.setAttribute("allow", "autoplay; fullscreen; gamepad");
  frame.setAttribute("title", document.title || "Game");
  owner.on("document-start", child => {
    if (!child || child.id !== frame.id || child.contentWindow !== frame.contentWindow) return;
    try { owner.eval(child, ${JSON.stringify(shimSource)}); }
    catch (error) { frame.dispatchEvent(new ErrorEvent("error", {message: String(error && error.message || error)})); }
  });
  frame.addEventListener("load", () => frame.focus());
  frame.src = ${JSON.stringify(frameUrl)};
  document.body.appendChild(frame);
})();\n`;
  return {
    entry: { ...entry, indexHtml: path.join(root, HOST), indexDir: path.join(root, path.posix.dirname(HOST)) },
    readinessFrame: { id: FRAME_ID, path: framePath },
    extraFiles: [
      { path: HOST, contents: `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><script src="construct-browser-host.js"></script></body></html>` },
      { path: "__maclauncher/construct-browser-host.js", contents: source }
    ]
  };
}
module.exports = { configuration };
