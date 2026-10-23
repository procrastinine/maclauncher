const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Modules = require("../src/modules/registry");
const Detect = require("../src/modules/love/detect");
const SevenZip = require("../src/modules/shared/runtime/sevenzip");
const { normalizeLoveVersion } = require("../src/modules/love/version");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, contents, options) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, options);
}

function writeBuffer(filePath, buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = String(entry.name || "");
    const nameBuffer = Buffer.from(name, "utf8");
    const dataBuffer = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(String(entry.data || ""), "utf8");
    const crc = crc32(dataBuffer);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuffer.length, 18);
    localHeader.writeUInt32LE(dataBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, dataBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuffer.length, 20);
    centralHeader.writeUInt32LE(dataBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + dataBuffer.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function writeZipArchive(filePath, entries) {
  writeBuffer(filePath, buildZipBuffer(entries));
}

function writeLoveArchive(filePath, version, identity = "test-love") {
  writeZipArchive(filePath, [
    {
      name: "conf.lua",
      data: [
        "function love.conf(t)",
        `  t.version = "${version}"`,
        `  t.identity = "${identity}"`,
        "end",
        ""
      ].join("\n")
    },
    {
      name: "main.lua",
      data: ["function love.load()", "end", ""].join("\n")
    }
  ]);
}

function createLoveAppBundle(appPath, { version = "11.5", bundleName = "Love Game" } = {}) {
  const executablePath = path.join(appPath, "Contents", "MacOS", "love");
  writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const embeddedLovePath = path.join(appPath, "Contents", "Resources", `${bundleName}.love`);
  writeLoveArchive(embeddedLovePath, version, "bundle-love");
  writeFile(
    path.join(appPath, "Contents", "Info.plist"),
    [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\"",
      "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
      "<plist version=\"1.0\">",
      "<dict>",
      "  <key>CFBundleExecutable</key>",
      "  <string>love</string>",
      "  <key>CFBundleName</key>",
      `  <string>${bundleName}</string>`,
      "  <key>CFBundleShortVersionString</key>",
      `  <string>${version}</string>`,
      "</dict>",
      "</plist>",
      ""
    ].join("\n")
  );
  return embeddedLovePath;
}

test("detectGame identifies direct .love archives", () => {
  const root = makeTempDir("maclauncher-love-detect-");
  try {
    const lovePath = path.join(root, "Archive.love");
    writeLoveArchive(lovePath, "0.10.2", "archive-love");

    const detected = Modules.detectGame(lovePath);
    assert.equal(detected.engine, "love");
    assert.equal(detected.gamePath, lovePath);
    assert.equal(detected.moduleData.sourceKind, "love-archive");
    assert.equal(detected.moduleData.detectedVersion, "0.10.2");
    assert.equal(detected.moduleData.saveIdentity, "archive-love");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies source directories from the fixture project", () => {
  const fixtureRoot = path.join(__dirname, "fixtures", "love", "source");
  const detected = Modules.detectGame(fixtureRoot);
  assert.equal(detected.engine, "love");
  assert.equal(detected.gamePath, fixtureRoot);
  assert.equal(detected.moduleData.sourceKind, "source-dir");
  assert.equal(detected.moduleData.detectedVersion, "11.5");
  assert.equal(detected.moduleData.saveIdentity, "fixture-love");
});

test("detectGame identifies native LÖVE app bundles and embedded archives", () => {
  const root = makeTempDir("maclauncher-love-app-");
  const appPath = path.join(root, "Bundle.app");
  try {
    const embeddedLovePath = createLoveAppBundle(appPath, {
      version: "11.5a",
      bundleName: "Bundle Game"
    });

    const detected = Modules.detectGame(appPath);
    assert.equal(detected.engine, "love");
    assert.equal(detected.runtimeId, "native");
    assert.equal(detected.nativeAppPath, appPath);
    assert.equal(detected.moduleData.sourceKind, "app-bundle");
    assert.equal(detected.moduleData.embeddedLovePath, embeddedLovePath);
    assert.equal(detected.moduleData.detectedVersion, "11.5a");
    assert.equal(detected.moduleData.detectedVersionNormalized, "11.5");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies fused Windows executables", () => {
  const root = makeTempDir("maclauncher-love-win-");
  try {
    const exePath = path.join(root, "Game.exe");
    const zipBuffer = buildZipBuffer([
      {
        name: "conf.lua",
        data: [
          "function love.conf(t)",
          '  t.version = "11.5"',
          '  t.identity = "windows-love"',
          "end",
          ""
        ].join("\n")
      },
      { name: "main.lua", data: "function love.load() end\n" }
    ]);
    writeBuffer(exePath, Buffer.concat([Buffer.from("MZ", "ascii"), Buffer.alloc(30), zipBuffer]));

    const detected = Modules.detectGame(exePath);
    assert.equal(detected.engine, "love");
    assert.equal(detected.moduleData.sourceKind, "windows-fused");
    assert.equal(detected.moduleData.packagedPath, exePath);
    assert.equal(detected.moduleData.detectedVersion, "11.5");
    assert.equal(detected.moduleData.saveIdentity, "windows-love");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame ignores unreliable love.dll version strings for Windows builds", () => {
  const root = makeTempDir("maclauncher-love-win-dll-");
  try {
    const exePath = path.join(root, "Game.exe");
    const zipBuffer = buildZipBuffer([
      {
        name: "conf.lua",
        data: [
          "function love.conf(t)",
          '  t.identity = "windows-love"',
          "end",
          ""
        ].join("\n")
      },
      { name: "main.lua", data: "function love.load() end\n" }
    ]);
    writeBuffer(exePath, Buffer.concat([Buffer.from("MZ", "ascii"), Buffer.alloc(30), zipBuffer]));
    writeFile(
      path.join(root, "love.dll"),
      "love.graphics.setColor(0.8, 0.3, 0.1)\0love.timer.sleep(0.1)\0"
    );

    const detected = Modules.detectGame(exePath);
    assert.equal(detected.engine, "love");
    assert.equal(detected.moduleData.detectedVersion, null);
    assert.equal(detected.moduleData.detectedVersionSource, null);
    assert.equal(detected.moduleData.saveIdentity, "windows-love");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies packaged Linux directories", () => {
  const root = makeTempDir("maclauncher-love-linux-");
  try {
    const launcherPath = path.join(root, "bin", "LinuxGame");
    const zipBuffer = buildZipBuffer([
      {
        name: "conf.lua",
        data: [
          "function love.conf(t)",
          '  t.version = "12.0"',
          '  t.identity = "linux-love"',
          "end",
          ""
        ].join("\n")
      },
      { name: "main.lua", data: "function love.load() end\n" }
    ]);
    const elfHeader = Buffer.alloc(32, 0);
    elfHeader[0] = 0x7f;
    elfHeader[1] = 0x45;
    elfHeader[2] = 0x4c;
    elfHeader[3] = 0x46;
    writeBuffer(launcherPath, Buffer.concat([elfHeader, zipBuffer]));
    writeBuffer(path.join(root, "lib", "liblove-12.0.so"), Buffer.from("liblove", "utf8"));

    const detected = Modules.detectGame(root);
    assert.equal(detected.engine, "love");
    assert.equal(detected.gamePath, root);
    assert.equal(detected.moduleData.sourceKind, "linux-fused");
    assert.equal(detected.moduleData.packagedPath, launcherPath);
    assert.equal(detected.moduleData.detectedVersion, "12.0");
    assert.equal(detected.moduleData.detectedVersionSource, "conf.lua");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies AppImage packages via 7-Zip listing", () => {
  const root = makeTempDir("maclauncher-love-appimage-");
  const appImagePath = path.join(root, "example-game.AppImage");
  const originalList = SevenZip.listArchiveEntriesSync;
  try {
    writeFile(appImagePath, "appimage");
    SevenZip.listArchiveEntriesSync = () => [
      { path: "AppRun" },
      { path: "bin/example-game" },
      { path: "lib/liblove-11.5.so" }
    ];

    const detected = Modules.detectGame(appImagePath);
    assert.equal(detected.engine, "love");
    assert.equal(detected.moduleData.sourceKind, "appimage");
    assert.equal(detected.moduleData.detectedVersion, "11.5");
    assert.equal(detected.moduleData.appImageReady, false);
    assert.equal(detected.moduleData.appImageLaunchRelativePath, "bin/example-game");
  } finally {
    SevenZip.listArchiveEntriesSync = originalList;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("normalizeLoveVersion handles compatibility shims used by the module", () => {
  assert.equal(normalizeLoveVersion("11.5a"), "11.5");
  assert.equal(normalizeLoveVersion("11.0.0"), "11.0");
  assert.equal(normalizeLoveVersion("0.10.2"), "0.10.2");
  assert.equal(normalizeLoveVersion("12.0"), "12.0");
});

test("parseLoveConf reads common version and identity fields", () => {
  const parsed = Detect.__test.parseLoveConf([
    "function love.conf(t)",
    '  t.version = "0.10.2"',
    '  t.identity = "example-identity"',
    "end",
    ""
  ].join("\n"));

  assert.equal(parsed.version, "0.10.2");
  assert.equal(parsed.identity, "example-identity");
});

test("detectLoveVersionFromDll ignores ordinary love.* API strings", () => {
  const root = makeTempDir("maclauncher-love-dll-version-");
  const dllPath = path.join(root, "love.dll");
  try {
    writeFile(
      dllPath,
      "love.graphics.setColor(0.8, 0.3, 0.1)\0world = love.physics.newWorld(0, 9.81*64)\0"
    );
    assert.equal(Detect.__test.detectLoveVersionFromDll(dllPath), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
