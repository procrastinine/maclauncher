// YoYo Games publishes GameMaker runtimes in Sparkle RSS feeds: one item per
// release, a core enclosure and one <module> per target, each with its size and
// DSA signature. The Studio 1.4 feed lists one Mac module per release.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const assert = require("node:assert/strict");
const Catalog = require("../../src/modules/gamemaker/runtime/official-catalog");
const Installer = require("../../src/modules/gamemaker/runtime/official-installer");

const [STABLE, LTS2026, LTS2022, STUDIO] = Catalog.FEEDS.map(feed => feed.url);
const signature = version => Buffer.from(`dsa ${version}`).toString("base64").padEnd(40, "A");
function moduleTag(name, version, file, extra = "") {
  return `<module name="${name}" url="https://gms.yoyogames.com/${file}" sparkle:version="${version}" length="${4096 + file.length}" sparkle:dsaSignature="${signature(version + file)}"${extra}/>`;
}
function item(version, { modules, core = `Zeus-Runtime-${version}.zip`, extra = "" } = {}) {
  modules ||= [["windows", `windows-${version}.zip`], ["android", `android-${version}.zip`], ["mac", `mac-${version}.zip`], ["macYYC", `macYYC-${version}.zip`],
    ["base-module-osx-arm64", `base-module-osx-arm64-${version}.zip`], ["base-module-osx-x64", `base-module-osx-x64-${version}.zip`], ["html5", `html5-${version}.zip`]];
  return `<item><title>Version ${version}</title><pubDate>Thu, 08 Oct 2026 10:00:00 GMT</pubDate><link>https://gamemaker.io/en/release-notes/runtime</link>${extra}` +
    `<enclosure url="https://gms.yoyogames.com/${core}" sparkle:version="${version}" length="${8192 + version.length}" type="application/octet-stream" sparkle:dsaSignature="${signature(version)}">` +
    modules.map(([name, file, attributes]) => moduleTag(name, version, file, attributes)).join("") + "</enclosure></item>";
}
function legacyItem(version) {
  return `<item><title>Version ${version}</title><enclosure sparkle:version="${version}"><module name="Windows" url="https://updater.yoyogames.com/api/download/win/0b4f6a52-8c49-4c4e-9d43-3f3a0d5e2a10.zip" sparkle:version="${version}" length="9000" sparkle:dsaSignature="${signature("w" + version)}"/>` +
    `<module name="Mac" url="https://updater.yoyogames.com/api/download/mac/55a7c0e7-fd96-45ae-971d-31164ec69b9e.zip" sparkle:version="${version}" length="9001" sparkle:dsaSignature="${signature("m" + version)}"/></enclosure></item>`;
}
const rss = (items, head = "") => `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>GameMaker Runtime</title>${head}${items.join("")}</channel></rss>`;
const feeds = stable => ({ [STABLE]: rss(stable), [LTS2026]: rss([item("2026.0.0.23")]), [LTS2022]: rss([item("2022.0.3.104")]), [STUDIO]: rss([legacyItem("1.4.9999")]) });
const current = feeds([item("2024.14.4.268"), item("2024.13.1.242")]);

module.exports = {
  managers: ["gamemaker-official"],
  current,
  scenarios: {
    newVersion: { routes: feeds([item("2025.0.0.1"), item("2024.14.4.268"), item("2024.13.1.242")]), version: "2025.0.0.1", usable: true },
    // Packages move to a folder on another YoYo Games host and the two CPU base
    // modules become one universal module.
    renamedAsset: { routes: { ...current, [STABLE]: rss([item("2025.0.0.1", { core: "runtimes/2025.0.0.1/core.zip", modules: [["mac", "runtimes/2025.0.0.1/mac.zip"],
      ["macYYC", "runtimes/2025.0.0.1/mac-yyc.zip"], ["base-module-osx-universal", "runtimes/2025.0.0.1/base-osx.zip"]] }), item("2024.14.4.268"), item("2024.13.1.242")]) },
    version: "2025.0.0.1", usable: true },
    // New targets, unknown attributes and elements, and a release this launcher cannot read.
    addedAsset: { routes: { ...current, [STABLE]: rss([item("2025.0.0.1", { extra: "<sparkle:releaseNotesLink>https://gamemaker.io/notes</sparkle:releaseNotesLink><sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>",
      modules: [["mac", "mac-2025.zip", ' sparkle:channel="stable" future="1"'], ["macYYC", "yyc-2025.zip"], ["base-module-osx-arm64", "arm-2025.zip"], ["base-module-osx-x64", "x64-2025.zip"],
        ["base-module-osx-riscv64", "riscv-2025.zip"], ["linux-arm64", "linux-arm64-2025.zip"], ["ios-simulator", "ios-sim-2025.zip"]] }), item("latest-preview"),
      item("2024.14.4.268"), item("2024.13.1.242")], "<sparkle:channel>stable</sparkle:channel><generator>YoYo</generator>") },
    version: "2025.0.0.1", usable: true },
    // A package replaced behind the same URL publishes a new size and signature.
    replacedFile: { routes: { ...current, [STABLE]: rss([item("2024.14.4.268").replace(/length="(\d+)"/, (_, size) => `length="${Number(size) + 1}"`)
      .replace(signature("2024.14.4.268"), signature("replaced")), item("2024.13.1.242")]) }, version: "2024.14.4.268", usable: true },
    deletedRelease: { routes: feeds([item("2024.14.4.268")]), version: "2024.14.4.268", usable: true, deleted: "2024.13.1.242" },
    // A retired channel no longer answers; the others still refresh.
    retiredChannel: { routes: { ...feeds([item("2025.0.0.1"), item("2024.14.4.268"), item("2024.13.1.242")]), [LTS2022]: { status: 404, headers: {}, body: Buffer.from("Not Found") } },
      version: "2025.0.0.1", usable: true, deleted: "2022.0.3.104" }
  },
  checks: {
    "GameMaker follows a package YoYo Games replaced and downloads it again": async (t, Harness) => {
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "future-upstream-gamemaker-"));
      t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
      const build = () => Installer.resolveBuild({ userDataDir, version: "2024.14.4.268" });
      // Each listed package answers with bytes of its published size.
      const files = () => Object.fromEntries(build().packages.map(pin => [pin.url, Buffer.alloc(pin.bytes)]));
      const refresh = async routes => {
        Harness.network.routes = routes;
        try { await Catalog.refreshCatalog({ userDataDir, force: true }); } finally { Harness.network.routes = null; }
      };
      const cache = async () => {
        const start = Harness.network.requests.length;
        Harness.network.routes = files();
        try { await Installer.cacheArtifacts({ userDataDir, build: build() }); } finally { Harness.network.routes = null; }
        return Harness.network.requests.slice(start);
      };
      await refresh(current);
      assert.equal((await cache()).length, 4);
      await refresh(module.exports.scenarios.replacedFile.routes);
      assert.equal(build().packages[0].signature, signature("replaced"));
      const downloads = await cache();
      assert.deepEqual(downloads, [build().packages[0].url], "only the replaced package downloads again");
    }
  }
};
