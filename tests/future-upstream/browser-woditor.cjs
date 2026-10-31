// Browser Woditor's download page links one ZIP per version.
const PAGE = "https://frostyhowl.com/browser-woditor/";
const page = links => ({ [PAGE]: `<!doctype html><html><body><h1>Browser Woditor</h1><ul>${links.map(href => `<li><a href="${href}">Download</a></li>`).join("")}</ul>
  <a href="/browser-woditor/changelog.html">Changelog</a><a href="https://example.com/ad.zip">Ad</a></body></html>` });
const current = ["/files/BrowserWoditor_0_6_2_0.zip", "/files/BrowserWoditor_0_6_1_2.zip"];
module.exports = { managers: ["browser-woditor"], current: page(current), scenarios: {
  newVersion: { routes: page(["/files/BrowserWoditor_0_7_0_0.zip", ...current]), version: "0.7.0.0", usable: true },
  // A shorter version, another separator and a download host on a subdomain.
  renamedAsset: { routes: page(["https://files.frostyhowl.com/BrowserWoditor-0.7.1.zip", ...current]), version: "0.7.1", usable: true },
  // A link that cannot be read leaves the others listed.
  unreadableLink: { routes: page(["http://[broken/BrowserWoditor_0_7_0_0.zip", ...current]), version: "0.6.2.0", usable: true },
  deletedRelease: { routes: page(current.slice(0, 1)), version: "0.6.2.0", usable: true, deleted: "0.6.1.2" }
},
checks: {
  "Browser Woditor installs from an archive that wraps its files in a folder": async t => {
    const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
    const Core = require("../../src/modules/wolfrpg/runtime/core");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "woditor-layout-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const files = { "BrowserWoditor 0.7/public/index.html": "<html></html>", "BrowserWoditor 0.7/BrowserWoditor.dat": "0.7",
      ...Object.fromEntries(Core.REQUIRED_FILES.filter(name => name !== "index.html").map(name => [`BrowserWoditor 0.7/public/${name}`, name])),
      "__MACOSX/BrowserWoditor 0.7/public/._index.html": "", "BrowserWoditor 0.7/README.txt": "notes" };
    const archive = path.join(root, "runtime.zip"), destination = path.join(root, "out");
    require("../helpers/metadata-archive")(archive, Object.entries(files));
    fs.mkdirSync(destination);
    Core.extractRuntime(archive, destination, "0.7.0");
    assert.equal(fs.readFileSync(path.join(destination, "public", "index.html"), "utf8"), "<html></html>");
    assert.equal(fs.readFileSync(path.join(destination, "BrowserWoditor.dat"), "utf8"), "0.7");
  }
} };
