const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const JavaModule = require("../src/modules/java/main");
const JavaExtract = require("../src/modules/java/extract");
const JavaManager = require("../src/modules/java/runtime/java-runtime-manager");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAgMBgJ+F3JYAAAAASUVORK5CYII=",
  "base64"
);

function createStoredZip(zipPath, entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = String(entry?.name || "").replace(/\\/g, "/");
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(entry?.data) ? entry.data : Buffer.from(String(entry?.data || ""), "utf8");

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // stored
    localHeader.writeUInt16LE(0, 10); // mtime
    localHeader.writeUInt16LE(0, 12); // mdate
    localHeader.writeUInt32LE(0, 14); // crc32 (unused by test parser)
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localRecord = Buffer.concat([localHeader, nameBuf, data]);
    localParts.push(localRecord);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(0, 10); // stored
    centralHeader.writeUInt16LE(0, 12); // mtime
    centralHeader.writeUInt16LE(0, 14); // mdate
    centralHeader.writeUInt32LE(0, 16); // crc32
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // comment
    centralHeader.writeUInt16LE(0, 34); // disk start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([centralHeader, nameBuf]));

    offset += localRecord.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const centralOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  fs.writeFileSync(zipPath, Buffer.concat([...localParts, centralDir, eocd]));
}

function createJavaInstall(userDataDir, { line, version, variant }) {
  const installDir = path.join(
    userDataDir,
    "runtimes",
    "java",
    String(line),
    version,
    variant
  );
  const javaPath = path.join(installDir, "bin", "java");
  fs.mkdirSync(path.dirname(javaPath), { recursive: true });
  fs.writeFileSync(javaPath, "");
  return { installDir, javaPath };
}

function createVineflowerInstall(userDataDir, version = "1.11.0") {
  const installDir = path.join(userDataDir, "runtimes", "vineflower", version);
  fs.mkdirSync(installDir, { recursive: true });
  const jarPath = path.join(installDir, "vineflower.jar");
  fs.writeFileSync(jarPath, "jar");
  return { installDir, jarPath, version };
}

test("Java source extraction installs the exact missing tool after consent and continues", async t => {
  const root = makeTempDir("maclauncher-java-tool-flow-");
  t.after(() => { JavaModule.__test.setRunCommandOverride(null); fs.rmSync(root, { recursive: true, force: true }); });
  const userDataDir = path.join(root, "data"), jarPath = path.join(root, "game.jar"), version = "1.11.0";
  fs.writeFileSync(jarPath, "jar"); createVineflowerInstall(userDataDir, "1.10.1");
  const variant = process.arch === "arm64" ? "arm64" : "x64";
  const java = createJavaInstall(userDataDir, { line: 17, version: "17.0.10+2", variant });
  const context = { userDataDir, settings: { runtimes: { java: { defaultLine: 17,
    lines: { 17: { defaultVersion: "17.0.10+2", defaultVariant: variant } }, vineflower: { defaultVersion: version } } } } };
  const events = []; context.confirmRuntimeInstall = async plan => {
    events.push("consent"); assert.equal(plan.label, "Vineflower"); assert.equal(plan.version, version); return true;
  };
  t.mock.method(JavaManager, "refreshCatalog", () => assert.fail("The selected tool needs no release discovery"));
  const install = t.mock.method(JavaManager, "installRuntime", async options => {
    events.push("install"); assert.equal(options.sectionId, "vineflower"); assert.equal(options.version, version);
    return createVineflowerInstall(userDataDir, version);
  });
  JavaModule.__test.setRunCommandOverride(async (cmd, args) => {
    events.push("decompile"); assert.equal(cmd, java.javaPath);
    assert.equal(args[1], path.join(userDataDir, "runtimes", "vineflower", version, "vineflower.jar"));
    return { stdout: "", stderr: "" };
  });
  const entry = { gameId: "java-tool-flow", gamePath: jarPath, moduleData: { jarPath } };
  const result = await JavaModule.actions.extractGame(entry, {}, context);
  assert.equal(result.vineflowerVersion, version); assert.deepEqual(events, ["consent", "install", "decompile"]);
  context.confirmRuntimeInstall = () => assert.fail("Installed decompilers run offline");
  await JavaModule.actions.extractGame(entry, {}, context);
  assert.equal(install.mock.callCount(), 1); assert.equal(events.at(-1), "decompile");
});

test("declining a missing Java decompiler tool or host preserves exports and avoids downloads", async t => {
  const root = makeTempDir("maclauncher-java-tool-cancel-");
  t.after(() => { JavaModule.__test.setRunCommandOverride(null); fs.rmSync(root, { recursive: true, force: true }); });
  const userDataDir = path.join(root, "data"), jarPath = path.join(root, "game.jar"); fs.writeFileSync(jarPath, "jar");
  const context = { userDataDir, settings: { runtimes: { java: { defaultLine: 17, vineflower: { defaultVersion: "1.11.0" },
    lines: { 17: { defaultVersion: "17.0.10+2", defaultVariant: process.arch === "arm64" ? "arm64" : "x64" } } } } } };
  const entry = { gameId: "java-tool-cancel", gamePath: jarPath, moduleData: { jarPath } };
  const output = JavaExtract.resolveExtractionRoot({ entry, userDataDir }); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "Existing.java"), "edited source");
  t.mock.method(JavaManager, "refreshCatalog", () => assert.fail("Declined tools cannot discover releases"));
  t.mock.method(JavaManager, "installRuntime", () => assert.fail("Declined tools cannot install"));
  JavaModule.__test.setRunCommandOverride(() => assert.fail("Declined tools cannot decompile"));
  const plans = []; context.confirmRuntimeInstall = async plan => { plans.push(plan); return false; };
  await assert.rejects(JavaModule.actions.extractGame(entry, {}, context), { code: "ABORT_ERR" });
  assert.equal(plans[0].label, "Vineflower");
  createVineflowerInstall(userDataDir, "1.11.0");
  await assert.rejects(JavaModule.actions.extractGame(entry, {}, context), { code: "ABORT_ERR" });
  assert.equal(plans[1].label, "Java 17"); assert.equal(plans[1].version, "17.0.10+2");
  assert.equal(fs.readFileSync(path.join(output, "Existing.java"), "utf8"), "edited source");
});

test("uncached Vineflower discovery follows consent and resumes extraction", async t => {
  const root = makeTempDir("maclauncher-java-tool-discovery-");
  t.after(() => { JavaModule.__test.setRunCommandOverride(null); fs.rmSync(root, { recursive: true, force: true }); });
  const userDataDir = path.join(root, "data"), jarPath = path.join(root, "game.jar"); fs.writeFileSync(jarPath, "jar");
  createJavaInstall(userDataDir, { line: 17, version: "17.0.10+2", variant: process.arch === "arm64" ? "arm64" : "x64" });
  const events = []; let versions = [];
  t.mock.method(JavaManager, "getState", () => ({ sections: [{ id: "vineflower", catalog: { versions } }] }));
  t.mock.method(JavaManager, "refreshCatalog", async options => {
    events.push("discover"); assert.equal(options.sectionId, "vineflower"); versions = ["1.11.0"];
  });
  t.mock.method(JavaManager, "installRuntime", async options => {
    events.push("install"); assert.equal(options.version, "1.11.0"); return createVineflowerInstall(userDataDir, options.version);
  });
  JavaModule.__test.setRunCommandOverride(async () => { events.push("decompile"); return { stdout: "", stderr: "" }; });
  const context = { userDataDir, settings: { runtimes: { java: { defaultLine: 17 } } },
    confirmRuntimeInstall: async () => { events.push("consent"); return true; } };
  await JavaModule.actions.extractGame({ gameId: "java-tool-discovery", gamePath: jarPath, moduleData: { jarPath } }, {}, context);
  assert.deepEqual(events, ["consent", "discover", "install", "decompile"]);
});

test("Vineflower's actual class version selects a compatible installed Java host", async t => {
  const root = makeTempDir("maclauncher-java-tool-class-version-");
  t.after(() => { JavaModule.__test.setRunCommandOverride(null); fs.rmSync(root, { recursive: true, force: true }); });
  const userDataDir = path.join(root, "data"), jarPath = path.join(root, "game.jar"); fs.writeFileSync(jarPath, "game");
  const vineflower = createVineflowerInstall(userDataDir, "1.11.0"), classHeader = Buffer.alloc(8);
  classHeader.writeUInt32BE(0xcafebabe); classHeader.writeUInt16BE(65, 6);
  createStoredZip(vineflower.jarPath, [{ name: "Decompiler.class", data: classHeader }]);
  const variant = process.arch === "arm64" ? "arm64" : "x64";
  createJavaInstall(userDataDir, { line: 17, version: "17.0.10+2", variant });
  const java21 = createJavaInstall(userDataDir, { line: 21, version: "21.0.4+7", variant });
  t.mock.method(JavaManager, "installRuntime", () => assert.fail("A compatible installed host needs no download"));
  const commands = []; JavaModule.__test.setRunCommandOverride(async cmd => { commands.push(cmd); return { stdout: "", stderr: "" }; });
  await JavaModule.actions.extractGame({ gameId: "java-tool-class-version", gamePath: jarPath, moduleData: { jarPath } }, {}, {
    userDataDir, settings: { runtimes: { java: { defaultLine: 17 } } }, confirmRuntimeInstall: () => assert.fail("An installed tool cannot prompt")
  });
  assert.deepEqual(commands, [java21.javaPath]);
});

test("resolveGameIcon extracts and caches a jar PNG icon", () => {
  const root = makeTempDir("maclauncher-java-module-");
  try {
    const jarPath = path.join(root, "Game.jar");
    createStoredZip(jarPath, [
      { name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\n" },
      { name: "images/splash.png", data: ONE_PIXEL_PNG },
      { name: "icons/icon.png", data: ONE_PIXEL_PNG }
    ]);
    const userDataDir = path.join(root, "userData");

    const entry = {
      gameId: "game-java",
      gamePath: jarPath,
      contentRootDir: root,
      moduleData: { jarPath },
      name: "Game"
    };

    const iconPath = JavaModule.resolveGameIcon(entry, { userDataDir });
    assert.ok(iconPath);
    assert.equal(fs.existsSync(iconPath), true);
    assert.ok(iconPath.endsWith(path.join("modules", "java", "icons", "jar-icon.png")));

    const cached = JavaModule.resolveGameIcon(entry, { userDataDir });
    assert.equal(cached, iconPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launchRuntime builds Java command from runtime settings", async () => {
  const root = makeTempDir("maclauncher-java-module-");
  try {
    const jarPath = path.join(root, "game", "Game.jar");
    fs.mkdirSync(path.dirname(jarPath), { recursive: true });
    fs.writeFileSync(jarPath, "jar");

    const userDataDir = path.join(root, "userData");
    createJavaInstall(userDataDir, {
      line: 21,
      version: "21.0.4+7",
      variant: process.arch === "arm64" ? "arm64" : "x64"
    });

    const entry = {
      gameId: "game-java",
      gamePath: jarPath,
      contentRootDir: path.dirname(jarPath),
      runtimeData: {
        java: {
          line: 21,
          version: "21.0.4+7"
        }
      },
      moduleData: {
        jarPath,
        runtimeLine: 21,
        requiredJava: 17
      }
    };

    const launches = [];
    const result = await JavaModule.launchRuntime("java", entry, {
      userDataDir,
      settings: {
        runtimes: {
          java: {
            defaultLine: 21,
            lines: {
              21: {
                defaultVersion: "21.0.4+7",
                defaultVariant: process.arch === "arm64" ? "arm64" : "x64"
              }
            }
          }
        }
      },
      runtimeSettings: {
        vmArgs: ["-Xmx2g", "-Ddemo=true"],
        appArgs: ["--debug", "--seed=42"],
        workingDir: "jar-dir"
      },
      spawnDetachedChecked: async (cmd, args, options, needsRosetta) => {
        launches.push({ cmd, args, options, needsRosetta });
        return { pid: 1234 };
      },
      logger: { info: () => {} }
    });

    assert.ok(result);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].cmd.endsWith("/bin/java"), true);
    assert.deepEqual(launches[0].args, [
      "-Xmx2g",
      "-Ddemo=true",
      "-jar",
      jarPath,
      "--debug",
      "--seed=42"
    ]);
    assert.equal(launches[0].options.cwd, path.dirname(jarPath));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtimeStatus reports readiness and unsupported lines", () => {
  const root = makeTempDir("maclauncher-java-module-");
  try {
    const userDataDir = path.join(root, "userData");

    const unsupportedEntry = {
      moduleData: {
        jarPath: "/Games/Test.jar",
        requiredJava: 29,
        runtimeLine: 29
      },
      runtimeData: {}
    };
    const unsupported = JavaModule.actions.runtimeStatus(unsupportedEntry, {}, {
      settings: { runtimes: { java: {} } },
      userDataDir
    });
    assert.equal(unsupported.ready, false);
    assert.equal(unsupported.unsupportedLine, true);

    createJavaInstall(userDataDir, {
      line: 17,
      version: "17.0.10+2",
      variant: process.arch === "arm64" ? "arm64" : "x64"
    });

    const supportedEntry = {
      moduleData: {
        jarPath: "/Games/Test.jar",
        requiredJava: 17,
        runtimeLine: 17
      },
      runtimeData: {
        java: {
          line: 17,
          version: "17.0.10+2"
        }
      }
    };
    const supported = JavaModule.actions.runtimeStatus(supportedEntry, {}, {
      settings: {
        runtimes: {
          java: {
            defaultLine: 17,
            lines: {
              17: {
                defaultVersion: "17.0.10+2",
                defaultVariant: process.arch === "arm64" ? "arm64" : "x64"
              }
            }
          }
        }
      },
      userDataDir
    });
    assert.equal(supported.ready, true);
    assert.equal(supported.installed, true);
    assert.equal(supported.resolvedVersion, "17.0.10+2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extract status actions update moduleData and remove extracted files", () => {
  const root = makeTempDir("maclauncher-java-module-");
  try {
    const userDataDir = path.join(root, "userData");
    const gameId = "game-java";
    const jarPath = path.join(root, "Game.jar");
    fs.writeFileSync(jarPath, "jar");

    const entry = {
      gameId,
      gamePath: jarPath,
      moduleData: { jarPath }
    };

    const initial = JavaModule.actions.refreshExtractionStatus(entry, {}, { userDataDir });
    assert.equal(initial.extractStatusLabel, "Not extracted");

    const extractRoot = JavaExtract.resolveExtractionRoot({ entry, userDataDir });
    fs.mkdirSync(extractRoot, { recursive: true });
    JavaExtract.writeExtractionMeta(extractRoot, {
      sourcePath: jarPath,
      extractedAt: 123
    });

    const refreshed = JavaModule.actions.refreshExtractionStatus(entry, {}, { userDataDir });
    assert.equal(refreshed.extractStatusLabel, "Extracted");
    assert.equal(entry.moduleData.extractedReady, true);
    assert.equal(entry.moduleData.extractedAt, 123);

    const removed = JavaModule.actions.removeExtraction(entry, {}, { userDataDir });
    assert.equal(removed.extractStatusLabel, "Not extracted");
    assert.equal(fs.existsSync(extractRoot), false);
    assert.equal(entry.moduleData.extractedReady, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extractGame writes extraction metadata with vineflower version", async () => {
  const root = makeTempDir("maclauncher-java-module-");
  try {
    const userDataDir = path.join(root, "userData");
    const jarPath = path.join(root, "Game.jar");
    fs.writeFileSync(jarPath, "jar");

    const javaInstall = createJavaInstall(userDataDir, {
      line: 17,
      version: "17.0.10+2",
      variant: process.arch === "arm64" ? "arm64" : "x64"
    });
    const vineflower = createVineflowerInstall(userDataDir, "1.11.0");

    const entry = {
      gameId: "game-java",
      gamePath: jarPath,
      contentRootDir: path.dirname(jarPath),
      moduleData: {
        jarPath,
        requiredJava: 17,
        runtimeLine: 17
      },
      runtimeData: {}
    };

    const calls = [];
    JavaModule.__test.setRunCommandOverride(async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { stdout: "", stderr: "" };
    });

    const result = await JavaModule.actions.extractGame(entry, {}, {
      settings: {
        runtimes: {
          java: {
            defaultLine: 17,
            lines: {
              17: {
                defaultVersion: "17.0.10+2",
                defaultVariant: process.arch === "arm64" ? "arm64" : "x64"
              }
            },
            vineflower: {
              defaultVersion: "1.11.0"
            }
          }
        }
      },
      userDataDir,
      logger: { info: () => {} },
      downloads: null
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, javaInstall.javaPath);
    assert.deepEqual(calls[0].args, [
      "-jar",
      vineflower.jarPath,
      jarPath,
      JavaExtract.resolveExtractionRoot({ entry, userDataDir })
    ]);

    const meta = JavaExtract.readExtractionMeta(
      JavaExtract.resolveExtractionRoot({ entry, userDataDir })
    );
    assert.equal(meta.vineflowerVersion, "1.11.0");
    assert.equal(meta.sourcePath, jarPath);
    assert.equal(result.vineflowerVersion, "1.11.0");
    assert.equal(entry.moduleData.extractedReady, true);
  } finally {
    JavaModule.__test.setRunCommandOverride(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
