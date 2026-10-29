const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Catalog = require("../../src/modules/gamemaker/runtime/official-catalog");
const Native = require("../../src/modules/shared/runtime/local-native");
const { image, ARM64, X64 } = require("../fixtures/macho-image");

const signature = "ABCDEFGHIJKLMNOPQRSTUVWX==";
const legacyFilename = "55a7c0e7-fd96-45ae-971d-31164ec69b9e.zip";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function legacyFeed(version = "1.4.9998", { bytes = 3, filename = legacyFilename } = {}) {
  return Buffer.from(`<rss><channel><item><enclosure sparkle:version="${version}"><module name="Mac" url="https://updater.yoyogames.com/api/download/mac/${filename}" sparkle:version="${version}" length="${bytes}" sparkle:dsaSignature="${signature}"/></enclosure></item></channel></rss>`);
}
function modernFeed(version = "2027.2.0.4") {
  const attributes = file => `url="https://gms.yoyogames.com/${file}.zip" sparkle:version="${version}" length="3" sparkle:dsaSignature="${signature}"`;
  return Buffer.from(`<rss><channel><item><enclosure ${attributes("core")}><module name="mac" ${attributes("mac")}/><module name="macYYC" ${attributes("yyc")}/><module name="base-module-osx-arm64" ${attributes("arm")}/><module name="base-module-osx-x64" ${attributes("intel")}/></enclosure></item></channel></rss>`);
}
async function discover(userDataDir, { modern = "2027.2.0.4", legacy = "1.4.9998", legacyBytes = 3 } = {}) {
  return Catalog.refreshCatalog({ userDataDir, fetch: async url => ({ status: 200,
    body: Catalog.FEEDS.find(feed => feed.url === url)?.family === "studio-1.4" ? legacyFeed(legacy, { bytes: legacyBytes }) : modernFeed(modern) }) });
}
function runnerApp(destination) {
  const executable = path.join(destination, "Contents/MacOS/Mac_Runner");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, image({ cpu: process.arch === "arm64" ? ARM64 : X64, fileType: 2, installName: null }), { mode: 0o755 });
  fs.writeFileSync(path.join(destination, "Contents/Info.plist"), '<plist><dict><key>CFBundleExecutable</key><string>Mac_Runner</string></dict></plist>');
  return executable;
}
function legacyReceipt(userDataDir, version) {
  const directory = path.join(userDataDir, "runtimes/gamemaker-official", version), app = path.join(directory, "YoYo Runner.app");
  const executable = runnerApp(app), diskImage = path.join(directory, "vendor/Mac-YoYoRunner.dmg");
  fs.mkdirSync(path.dirname(diskImage)); fs.writeFileSync(diskImage, "fixture disk image");
  const record = { version, family: "studio-1.4", source: "vendor-legacy-package", upstreamRevision: `vendor-runtime:${version}`,
    runnerAppPath: app, diskImagePath: diskImage, binarySha256: Native.hashFile(executable), diskImageSha256: Native.hashFile(diskImage),
    runnerTreeSha256: require("../../src/modules/gamemaker/runtime/official-launch").hashRunnerTree(app), launchReady: true,
    packages: [{ filename: legacyFilename, url: `https://store.yoyogames.com/downloads/gm-studio/${legacyFilename}`, bytes: 3, sha256: hash("ZIP") }] };
  fs.writeFileSync(path.join(directory, "runtime.json"), JSON.stringify(record));
  return record;
}
module.exports = { signature, legacyFilename, legacyFeed, modernFeed, discover, runnerApp, legacyReceipt, hash };
