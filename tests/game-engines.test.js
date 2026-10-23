const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Modules = require("../src/modules/registry");
const { writeZipArchive } = require("./helpers/zip-fixture");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function writeBuffer(filePath, buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
}

function writeJson(filePath, data) {
  writeFile(filePath, JSON.stringify(data, null, 2));
}

function buildPckHeader({ packVersion = 3, major = 4, minor = 2, patch = 1 } = {}) {
  const buf = Buffer.alloc(20);
  buf.write("GDPC", 0, 4, "ascii");
  buf.writeUInt32LE(packVersion, 4);
  buf.writeUInt32LE(major, 8);
  buf.writeUInt32LE(minor, 12);
  buf.writeUInt32LE(patch, 16);
  return buf;
}

function buildEmbeddedElfPack(pack) {
  const header = Buffer.alloc(32, 0);
  header[0] = 0x7f;
  header[1] = 0x45;
  header[2] = 0x4c;
  header[3] = 0x46;
  header[4] = 2;
  header[5] = 1;
  const trailer = Buffer.alloc(12);
  trailer.writeBigUInt64LE(BigInt(pack.length), 0);
  trailer.write("GDPC", 8, 4, "ascii");
  return Buffer.concat([header, pack, trailer]);
}

function createClassHeader(javaMajor) {
  const major = Number(javaMajor) + 44;
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(0xcafebabe, 0);
  buf.writeUInt16BE(0, 4);
  buf.writeUInt16BE(major, 6);
  return buf;
}

test("detectGame identifies Java jar files and captures runtime hints", () => {
  const root = makeTempDir("maclauncher-java-");
  try {
    const jarPath = path.join(root, "Game.jar");
    writeZipArchive(jarPath, [
      {
        name: "META-INF/MANIFEST.MF",
        data: [
          "Manifest-Version: 1.0",
          "Main-Class: com.example.Main",
          "Implementation-Title: Jar Test",
          "Build-Jdk-Spec: 17",
          "Multi-Release: true",
          ""
        ].join("\n")
      },
      { name: "com/example/Main.class", data: createClassHeader(17) },
      { name: "META-INF/versions/21/com/example/Main.class", data: createClassHeader(21) }
    ]);

    const detected = Modules.detectGame(jarPath);
    assert.equal(detected.engine, "java");
    assert.equal(detected.gamePath, jarPath);
    assert.equal(detected.contentRootDir, root);
    assert.equal(detected.name, "Jar Test");
    assert.equal(detected.moduleData.mainClass, "com.example.Main");
    assert.equal(detected.moduleData.requiredJava, 17);
    assert.equal(detected.moduleData.recommendedJava, 21);
    assert.equal(detected.moduleData.runtimeLine, 17);
    assert.equal(detected.moduleData.detectedJavaSource, "mixed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Java single-jar directories when runnable", () => {
  const root = makeTempDir("maclauncher-java-dir-");
  try {
    const gameDir = path.join(root, "jar-dir");
    const jarPath = path.join(gameDir, "single.jar");
    writeZipArchive(jarPath, [
      {
        name: "META-INF/MANIFEST.MF",
        data: ["Manifest-Version: 1.0", "Main-Class: DemoMain", ""].join("\n")
      },
      { name: "DemoMain.class", data: createClassHeader(11) }
    ]);

    const detected = Modules.detectGame(gameDir);
    assert.equal(detected.engine, "java");
    assert.equal(detected.gamePath, jarPath);
    assert.equal(detected.moduleData.mainClass, "DemoMain");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame does not false-positive on non-runnable single-jar directories", () => {
  const root = makeTempDir("maclauncher-java-dir-");
  try {
    const gameDir = path.join(root, "jar-dir");
    const jarPath = path.join(gameDir, "single.jar");
    writeZipArchive(jarPath, [
      { name: "META-INF/MANIFEST.MF", data: ["Manifest-Version: 1.0", ""].join("\n") },
      { name: "DemoMain.class", data: createClassHeader(11) }
    ]);
    assert.throws(() => Modules.detectGame(gameDir));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies direct .swf imports as Flash", () => {
  const root = makeTempDir("maclauncher-flash-");
  try {
    const swfPath = path.join(root, "Demo.SWF");
    writeBuffer(swfPath, Buffer.from("FWS"));

    const detected = Modules.detectGame(swfPath);
    assert.equal(detected.engine, "flash");
    assert.equal(detected.gameType, "scripted");
    assert.equal(detected.gamePath, swfPath);
    assert.equal(detected.contentRootDir, root);
    assert.equal(detected.name, "Demo");
    assert.equal(detected.moduleData.swfPath, swfPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame does not false-positive as Flash on non-swf files", () => {
  const root = makeTempDir("maclauncher-flash-");
  try {
    const html = path.join(root, "index.html");
    writeFile(html, "<html></html>");
    const txtPath = path.join(root, "notes.txt");
    writeFile(txtPath, "hello");

    assert.throws(() => Modules.detectGame(txtPath), error => error.code === "DETECTION_UNSUPPORTED");
    assert.equal(Modules.detectGame(html).engine, "web");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame prefers direct .swf detection over parent-folder Construct artifacts", () => {
  const root = makeTempDir("maclauncher-flash-");
  try {
    const swfPath = path.join(root, "bloonstd4.swf");
    writeBuffer(swfPath, Buffer.from("FWS"));
    // Simulate an unrelated packaged web export artifact in the same folder.
    writeBuffer(path.join(root, "package.nw"), Buffer.from("PK\x03\x04"));

    const detected = Modules.detectGame(swfPath);
    assert.equal(detected.engine, "flash");
    assert.equal(detected.gamePath, swfPath);
    assert.equal(detected.moduleData.swfPath, swfPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies RPG Maker MV and uses System.json title", () => {
  const root = makeTempDir("maclauncher-engine-");
  try {
    const mvDir = path.join(root, "mv");
    writeFile(path.join(mvDir, "index.html"), "<html></html>");
    writeFile(path.join(mvDir, "js", "rpg_core.js"), "");
    writeJson(path.join(mvDir, "data", "System.json"), { gameTitle: "MV Title" });

    const mvDetected = Modules.detectGame(mvDir);
    assert.equal(mvDetected.engine, "mv");
    assert.equal(mvDetected.gamePath, mvDir);
    assert.equal(mvDetected.indexHtml, path.join(mvDir, "index.html"));
    assert.equal(mvDetected.name, "MV Title");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies RPG Maker MZ", () => {
  const root = makeTempDir("maclauncher-engine-");
  try {
    const mzDir = path.join(root, "mz");
    writeFile(path.join(mzDir, "index.html"), "<html></html>");
    writeFile(path.join(mzDir, "js", "rmmz_core.js"), "");

    const mzDetected = Modules.detectGame(mzDir);
    assert.equal(mzDetected.engine, "mz");
    assert.equal(mzDetected.gamePath, mzDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies RPG Maker MV inside a .app bundle", () => {
  const root = makeTempDir("maclauncher-app-");
  const appPath = path.join(root, "Test.app");
  try {
    const appNw = path.join(appPath, "Contents", "Resources", "app.nw");
    writeFile(path.join(appNw, "index.html"), "<html></html>");
    writeFile(path.join(appNw, "js", "rpg_core.js"), "");

    const detected = Modules.detectGame(appPath);
    assert.equal(detected.engine, "mv");
    assert.equal(detected.gamePath, appPath);
    assert.equal(detected.contentRootDir, appNw);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Ren'Py root folder and build_info name", () => {
  const root = makeTempDir("maclauncher-renpy-");
  try {
    writeFile(path.join(root, "renpy", "vc_version.py"), 'version = "8.2.1"\n');
    writeFile(path.join(root, "game", "script.rpy"), "# script");
    writeJson(path.join(root, "game", "cache", "build_info.json"), { name: "RenPy Game" });

    const detected = Modules.detectGame(root);
    assert.equal(detected.engine, "renpy");
    assert.equal(detected.moduleData.major, 8);
    assert.equal(detected.moduleData.version, "8.2.1");
    assert.equal(detected.moduleData.gameOnly, false);
    assert.equal(detected.name, "RenPy Game");
    assert.equal(detected.gameType, "scripted");
    assert.equal(detected.indexHtml, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame falls back to Ren'Py __init__.py when vc_version is not dotted", () => {
  const root = makeTempDir("maclauncher-renpy-");
  try {
    writeFile(path.join(root, "renpy", "vc_version.py"), "version = '606'\n");
    writeFile(path.join(root, "renpy", "__init__.py"), "version_tuple = (7, 3, 5, vc_version)\n");
    writeFile(path.join(root, "game", "script.rpy"), "# script");

    const detected = Modules.detectGame(root);
    assert.equal(detected.engine, "renpy");
    assert.equal(detected.moduleData.major, 7);
    assert.equal(detected.moduleData.version, "7.3.5");
    assert.equal(detected.moduleData.gameOnly, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Ren'Py game folder only", () => {
  const root = makeTempDir("maclauncher-renpy-");
  const gameDir = path.join(root, "game");
  try {
    writeFile(path.join(gameDir, "script_version.txt"), "7, 4, 11\n");
    writeFile(path.join(gameDir, "main.rpy"), "# script");

    const detected = Modules.detectGame(gameDir);
    assert.equal(detected.engine, "renpy");
    assert.equal(detected.moduleData.major, 7);
    assert.equal(detected.moduleData.version, "7.4.11");
    assert.equal(detected.moduleData.gameOnly, true);
    assert.equal(detected.gamePath, gameDir);
    assert.equal(detected.contentRootDir, gameDir);
    assert.equal(detected.name, path.basename(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Ren'Py when dropping a launcher .exe and uses project root", () => {
  const root = makeTempDir("maclauncher-renpy-exe-");
  try {
    const exePath = path.join(root, "MyRenpyGame.exe");
    writeBuffer(exePath, Buffer.from("MZ"));
    writeFile(path.join(root, "renpy", "vc_version.py"), 'version = "8.2.1"\n');
    writeFile(path.join(root, "game", "script.rpy"), "# script");

    const detected = Modules.detectGame(exePath);
    assert.equal(detected.engine, "renpy");
    assert.equal(detected.gamePath, root);
    assert.equal(detected.moduleData.baseName, "MyRenpyGame");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies RGSS when dropping a Windows executable and uses game folder", () => {
  const root = makeTempDir("maclauncher-rgss-exe-");
  try {
    const exePath = path.join(root, "Game.exe");
    writeBuffer(exePath, Buffer.from("MZ"));
    writeFile(path.join(root, "Game.ini"), "[Game]\nTitle=RGSS Test\n");
    writeFile(path.join(root, "RGSS301.dll"), "");

    const detected = Modules.detectGame(exePath);
    assert.equal(detected.engine, "rgss");
    assert.equal(detected.gamePath, root);
    assert.equal(detected.name, "RGSS Test");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame treats .jar as Java even with sibling web artifacts", () => {
  const root = makeTempDir("maclauncher-java-priority-");
  try {
    const jarPath = path.join(root, "Game.jar");
    writeZipArchive(jarPath, [
      {
        name: "META-INF/MANIFEST.MF",
        data: ["Manifest-Version: 1.0", "Main-Class: demo.Main", ""].join("\n")
      },
      { name: "demo/Main.class", data: createClassHeader(17) }
    ]);
    writeFile(path.join(root, "index.html"), "<html></html>");
    writeBuffer(path.join(root, "package.nw"), Buffer.from("PK\x03\x04"));

    const detected = Modules.detectGame(jarPath);
    assert.equal(detected.engine, "java");
    assert.equal(detected.gamePath, jarPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame treats .py and .sh launchers as Ren'Py when project markers exist", () => {
  const root = makeTempDir("maclauncher-renpy-priority-");
  try {
    const pyPath = path.join(root, "MyGame.py");
    const shPath = path.join(root, "MyGame.sh");
    writeFile(pyPath, "print('launch')");
    writeFile(shPath, "#!/bin/sh\necho launch\n");
    writeFile(path.join(root, "renpy", "vc_version.py"), 'version = "8.2.1"\n');
    writeFile(path.join(root, "game", "script.rpy"), "# script");
    writeFile(path.join(root, "index.html"), "<html></html>");
    writeBuffer(path.join(root, "package.nw"), Buffer.from("PK\x03\x04"));

    const pyDetected = Modules.detectGame(pyPath);
    assert.equal(pyDetected.engine, "renpy");
    assert.equal(pyDetected.gamePath, root);
    assert.equal(pyDetected.moduleData.baseName, "MyGame");

    const shDetected = Modules.detectGame(shPath);
    assert.equal(shDetected.engine, "renpy");
    assert.equal(shDetected.gamePath, root);
    assert.equal(shDetected.moduleData.baseName, "MyGame");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame does not fall back to web for non-Ren'Py .py launchers", () => {
  const root = makeTempDir("maclauncher-renpy-priority-");
  try {
    const pyPath = path.join(root, "Tool.py");
    writeFile(pyPath, "print('tool')");
    writeFile(path.join(root, "index.html"), "<html></html>");

    assert.throws(
      () => Modules.detectGame(pyPath),
      err => err?.name === "DetectionError" && /^Unsupported \.py input for .*Ren'Py$/.test(err.message)
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Godot app bundles with PCK", () => {
  const root = makeTempDir("maclauncher-godot-app-");
  const appPath = path.join(root, "GodotGame.app");
  try {
    const pckPath = path.join(appPath, "Contents", "Resources", "GodotGame.pck");
    writeBuffer(pckPath, buildPckHeader({ major: 4, minor: 2, patch: 1 }));

    const detected = Modules.detectGame(appPath);
    assert.equal(detected.engine, "godot");
    assert.equal(detected.gamePath, appPath);
    assert.equal(detected.moduleData.packagedType, "app-bundle");
    assert.equal(detected.moduleData.packPath, pckPath);
    assert.equal(detected.moduleData.detectedMajor, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Godot ELF launchers without executable bits", () => {
  const root = makeTempDir("maclauncher-godot-elf-");
  try {
    const launcherPath = path.join(root, "GodotGame.x86_64");
    const pack = Buffer.concat([buildPckHeader({ major: 4, minor: 6, patch: 0 }), Buffer.alloc(8, 1)]);
    writeBuffer(launcherPath, buildEmbeddedElfPack(pack));
    fs.chmodSync(launcherPath, 0o644);

    const detected = Modules.detectGame(launcherPath);
    assert.equal(detected.engine, "godot");
    assert.equal(detected.gamePath, launcherPath);
    assert.equal(detected.moduleData.packagedType, "elf-embedded");
    assert.equal(detected.moduleData.packPath, launcherPath);
    assert.equal(detected.moduleData.detectedVersion, "4.6.0");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Godot directories from a Linux launcher binary", () => {
  const root = makeTempDir("maclauncher-godot-linux-dir-");
  try {
    const gameDir = path.join(root, "GodotGame");
    const launcherPath = path.join(gameDir, "GodotGame.x86_64");
    const pack = Buffer.concat([buildPckHeader({ major: 3, minor: 5, patch: 2 }), Buffer.alloc(8, 1)]);
    writeBuffer(launcherPath, buildEmbeddedElfPack(pack));
    fs.chmodSync(launcherPath, 0o644);

    const detected = Modules.detectGame(gameDir);
    assert.equal(detected.engine, "godot");
    assert.equal(detected.gamePath, gameDir);
    assert.equal(detected.moduleData.packagedType, "elf-embedded");
    assert.equal(detected.moduleData.packagedPath, launcherPath);
    assert.equal(detected.moduleData.detectedVersion, "3.5.2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Godot project directories", () => {
  const root = makeTempDir("maclauncher-godot-project-");
  try {
    writeFile(path.join(root, "project.godot"), "config_version=5\n");
    const detected = Modules.detectGame(root);
    assert.equal(detected.engine, "godot");
    assert.equal(detected.gamePath, root);
    assert.equal(detected.moduleData.packagedType, "project-dir");
    assert.equal(detected.moduleData.detectedMajor, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame treats Ren'Py 6 as legacy Ren'Py (Python 2)", () => {
  const root = makeTempDir("maclauncher-renpy-");
  const gameDir = path.join(root, "game");
  try {
    writeFile(path.join(gameDir, "script_version.txt"), "6, 99, 12\n");
    writeFile(path.join(gameDir, "main.rpy"), "# script");

    const detected = Modules.detectGame(gameDir);
    assert.equal(detected.engine, "renpy");
    assert.equal(detected.moduleData.major, 7);
    assert.equal(detected.moduleData.version, "6.99.12");
    assert.equal(detected.moduleData.gameOnly, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Construct runtimes", () => {
  const root = makeTempDir("maclauncher-construct-");
  try {
    const c3Dir = path.join(root, "construct3");
    writeFile(path.join(c3Dir, "index.html"), "<html></html>");
    writeFile(path.join(c3Dir, "c3runtime.js"), "");

    const detected = Modules.detectGame(c3Dir);
    assert.equal(detected.engine, "construct");
    assert.equal(detected.moduleData.constructRuntime, "Construct 3");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Construct C3 exports without c3runtime.js", t => {
  const exampleDir = makeTempDir("maclauncher-construct3-export-");
  t.after(() => fs.rmSync(exampleDir, { recursive: true, force: true }));
  writeFile(path.join(exampleDir, "index.html"), "<html><script src='scripts/c3main.js'></script></html>");
  writeFile(path.join(exampleDir, "scripts", "c3main.js"), "");
  const detected = Modules.detectGame(exampleDir);
  assert.equal(detected.engine, "construct");
  assert.equal(detected.moduleData.constructRuntime, "Construct 3");
});

test("detectGame identifies Construct package.nw bundles", t => {
  const exampleDir = makeTempDir("maclauncher-construct2-package-");
  t.after(() => fs.rmSync(exampleDir, { recursive: true, force: true }));
  const packageNw = path.join(exampleDir, "package.nw");
  writeZipArchive(packageNw, [
    { name: "index.html", data: "<html></html>" },
    { name: "c2runtime.js", data: "" }
  ]);
  const detected = Modules.detectGame(exampleDir);
  assert.equal(detected.engine, "construct");
  assert.equal(detected.moduleData.packagedType, "package.nw");
  assert.equal(detected.moduleData.packagedPath, packageNw);
  assert.equal(detected.moduleData.constructRuntime, "Construct 2");
});

test("detectGame identifies NScripter roots", () => {
  const root = makeTempDir("maclauncher-nscripter-");
  try {
    const script = Buffer.from("*define\ncaption \"Example\"\ngame\n*start\nend\n");
    for (let index = 0; index < script.length; index++) script[index] ^= 0x84;
    writeFile(path.join(root, "nscript.dat"), script);
    const detected = Modules.detectGame(root);
    assert.equal(detected.engine, "nscripter");
    assert.equal(detected.gameType, "scripted");
    assert.equal(detected.moduleData.scriptFormat, "xor-84");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies NScripter roots with 0.utf", () => {
  const root = makeTempDir("maclauncher-nscripter-");
  try {
    writeFile(path.join(root, "0.utf"), "*define\ngame\n*start\nend\n");
    const detected = Modules.detectGame(root);
    assert.equal(detected.engine, "nscripter");
    assert.equal(detected.gameType, "scripted");
    assert.equal(detected.moduleData.scriptFormat, "utf8-plain");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies NScripter packaged exe", t => {
  const root = makeTempDir("maclauncher-nscripter-package-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exePath = path.join(root, "Example.exe");
  writeZipArchive(exePath, [
    { name: "0.txt", data: "*define\ngame\n*start\nend\n" },
    { name: "arc.nsa", data: Buffer.alloc(0) }
  ]);
  const detected = Modules.detectGame(exePath);
  assert.equal(detected.engine, "nscripter");
  assert.equal(detected.gamePath, exePath);
  assert.equal(detected.moduleData.packagedPath, exePath);
  assert.equal(detected.moduleData.packagedType, "zip-exe");
});

test("detectGame identifies Tyrano roots with kag.js", () => {
  const root = makeTempDir("maclauncher-tyrano-");
  try {
    writeFile(path.join(root, "index.html"), "<html></html>");
    writeFile(
      path.join(root, "tyrano", "plugins", "kag", "kag.js"),
      "TYRANO_ENGINE_VERSION = \"5.10\";"
    );
    const detected = Modules.detectGame(root);
    assert.equal(detected.engine, "tyrano");
    assert.equal(detected.moduleData.version, "5.10");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Tyrano packaged exe when folder is dropped", t => {
  const root = makeTempDir("maclauncher-tyrano-package-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exePath = path.join(root, "Example.exe");
  writeZipArchive(exePath, [
    { name: "index.html", data: "<html></html>" },
    { name: "builder_config.json", data: "{}" },
    { name: "tyrano/plugins/kag/kag.js", data: 'TYRANO_ENGINE_VERSION = "5.10";' }
  ], { prefix: Buffer.concat([Buffer.from("MZ"), Buffer.alloc(510)]) });
  const detected = Modules.detectGame(root);
  assert.equal(detected.engine, "tyrano");
  assert.equal(detected.moduleData.packagedType, "zip-exe");
  assert.equal(detected.moduleData.packagedPath, exePath);
});

test("detectGame falls back to Web module for generic index.html", () => {
  const root = makeTempDir("maclauncher-web-");
  try {
    writeFile(path.join(root, "index.html"), "<html></html>");
    const detected = Modules.detectGame(root);
    assert.equal(detected.engine, "web");
    assert.equal(detected.gameType, "web");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Web app bundles", () => {
  const root = makeTempDir("maclauncher-web-app-");
  const appPath = path.join(root, "Web.app");
  try {
    const appNw = path.join(appPath, "Contents", "Resources", "app.nw");
    writeFile(path.join(appNw, "index.html"), "<html></html>");
    const detected = Modules.detectGame(appPath);
    assert.equal(detected.engine, "web");
    assert.equal(detected.contentRootDir, appNw);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Web app bundles with Resources/app dist layout", () => {
  const root = makeTempDir("maclauncher-web-app-");
  const appPath = path.join(root, "WebDist.app");
  try {
    const appRoot = path.join(appPath, "Contents", "Resources", "app");
    writeFile(path.join(appRoot, "dist", "index.html"), "<html></html>");
    writeJson(path.join(appRoot, "package.json"), { name: "web-dist" });
    fs.mkdirSync(path.join(appRoot, "node_modules"), { recursive: true });

    const detected = Modules.detectGame(appPath);
    assert.equal(detected.engine, "web");
    assert.equal(detected.contentRootDir, appRoot);
    assert.equal(detected.indexHtml, path.join(appRoot, "dist", "index.html"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Web resources/app dist layout", () => {
  const root = makeTempDir("maclauncher-web-resources-");
  try {
    const appRoot = path.join(root, "resources", "app");
    writeFile(path.join(appRoot, "dist", "index.html"), "<html></html>");
    writeJson(path.join(appRoot, "package.json"), { name: "web-resources" });
    fs.mkdirSync(path.join(appRoot, "node_modules"), { recursive: true });

    const detected = Modules.detectGame(root);
    assert.equal(detected.engine, "web");
    assert.equal(detected.contentRootDir, appRoot);
    assert.equal(detected.indexHtml, path.join(appRoot, "dist", "index.html"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("supported module labels include RPG Maker and Ren'Py", () => {
  const labels = Modules.listSupportedModules();
  assert.ok(labels.includes("RPG Maker MV"));
  assert.ok(labels.includes("RPG Maker MZ"));
  assert.ok(labels.includes("RPG Maker XP/VX/VX Ace"));
  assert.ok(labels.includes("Ren'Py"));
});
