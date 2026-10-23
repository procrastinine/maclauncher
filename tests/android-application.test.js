const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Application = require("../src/modules/android/application");

test("Android application bundle names preserve titles without filesystem separators", () => {
  assert.equal(Application.bundleName("Temple Run 2"), "Temple Run 2.app");
  assert.equal(Application.bundleName("../a:b/試験\u0000"), " a b 試験.app".trim());
  assert.equal(Application.bundleName("..."), "Android.app");
  assert.ok(Buffer.byteLength(Application.bundleName("遊".repeat(500))) <= 184);
});

test("Android bundle icons share the rounded Dock image through native IconServices", { skip: process.platform !== "darwin" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-icon-"));
  try {
    const helper = path.join(root, "application-icon"), probe = path.join(root, "icon-probe"), icon = path.join(root, "icon.png");
    for (const [source, output] of [["src/modules/android/native/application-icon.m", helper],
      ["tests/fixtures/android-application-icon/IconProbe.m", probe]])
      execFileSync("clang", ["-fobjc-arc", source, "-framework", "AppKit", "-o", output]);
    execFileSync(probe, ["create", icon]);
    const dockIcon = await require("../src/modules/shared/dock-icon").prepare(icon, path.join(root, "dock-icons"));
    const javaPath = path.join(root, "jdk/bin/java");
    fs.mkdirSync(path.dirname(javaPath), { recursive: true });
    fs.copyFileSync("/usr/bin/true", javaPath);
    const options = { executablePath: javaPath, directory: path.join(root, "application"), title: "Original Android Icon", iconFile: icon, iconHelper: helper };
    const application = await Application.prepare(options, async (command, args) => {
      if (command === helper) execFileSync("/usr/bin/codesign", ["--verify", "--strict", args[0]]);
      execFileSync(command, args);
    });
    execFileSync(probe, ["compare", dockIcon, application.app]);
    // Finder's public custom-icon operation adds FinderInfo/resource metadata;
    // the sealed app contents and executable must still verify afterwards.
    execFileSync("/usr/bin/codesign", ["--verify", application.app]);
    const cached = await Application.prepare(options, async () => assert.fail("Unchanged icon must reuse the native bundle"));
    assert.deepEqual(cached, application);
    const before = fs.statSync(probe), originalHash = crypto.createHash("sha256").update(fs.readFileSync(probe)).digest("hex");
    const shared = path.join(root, "shared-runtime"); fs.mkdirSync(shared); fs.writeFileSync(path.join(shared, "runtime-library"), "shared library");
    const data = path.join(root, "game-data"); fs.mkdirSync(data); fs.writeFileSync(path.join(data, "save"), "original save");
    const title = "Standalone Android Game", executableName = Application.bundleName(title).slice(0, -4);
    const standaloneOptions = { executablePath: probe, executableName, directory: path.join(root, "standalone-application"),
      title, iconFile: icon, iconHelper: helper, showInDock: true, links: { lib: shared, data } };
    const standalone = await Application.prepare(standaloneOptions);
    const output = execFileSync(standalone.executablePath, ["application", dockIcon, title, standalone.identifier, String(process.pid)], {encoding:"utf8", timeout:15000});
    assert.match(output, /PASS standalone application name, executable, Dock policy and separate process identity/);
    assert.ok(Number(output.match(/IconServices mean pixel difference: ([\d.]+)/)?.[1]) < 1, "The standalone process retains the prepared icon within native rendering precision");
    assert.notEqual(fs.statSync(standalone.executablePath).ino, before.ino, "A re-signed entry is never hardlinked to its supplier");
    assert.equal(fs.statSync(probe).nlink, before.nlink);
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(probe)).digest("hex"), originalHash, "Re-signing the cloned entry preserves the original executable");
    assert.equal(path.basename(standalone.executablePath), executableName);
    for (const [name, target] of Object.entries(standaloneOptions.links)) {
      const link = path.join(standalone.app, "Contents", name);
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true); assert.equal(fs.realpathSync(link), fs.realpathSync(target));
    }
    assert.deepEqual(fs.readdirSync(path.join(standalone.app, "Contents")).sort(), ["Info.plist", "MacOS", "Resources", "_CodeSignature", "data", "lib"]);
    assert.deepEqual(await Application.prepare(standaloneOptions, async () => assert.fail("Unchanged native identity reuses its clone")), standalone);
    const isolatedOptions = { ...standaloneOptions, links: {}, iconHelper: null, directory: path.join(root, "isolated-application") };
    const isolated = await Application.prepare(isolatedOptions);
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", isolated.app]);
    assert.deepEqual(await Application.prepare(isolatedOptions, async () => assert.fail("The display entry reuses its signed clone")), isolated);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Cosmetic icon assignment failures preserve launch and retry without rebuilding the entry", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-icon-retry-"));
  try {
    const javaPath = path.join(root, "jdk/bin/java"), iconFile = path.join(root, "icon.png"), iconHelper = path.join(root, "icon-helper");
    fs.mkdirSync(path.dirname(javaPath), { recursive: true }); fs.writeFileSync(javaPath, "launcher");
    fs.writeFileSync(iconHelper, "native helper identity");
    fs.writeFileSync(iconFile, require("../src/core/icon-utils").encodePngBitmap({width:256, height:256, buffer:Buffer.alloc(256*256*4,255)}));
    const options = { executablePath: javaPath, directory: path.join(root, "application"), title: "Icon retry", iconFile, iconHelper };
    let signs = 0, icons = 0;
    const execute = async command => { if (command === iconHelper) { if (++icons === 1) throw Error("Icon service temporarily unavailable"); } else signs++; };
    const warning = t.mock.method(console, "warn", () => {});
    const first = await Application.prepare(options, execute);
    assert.equal(warning.mock.callCount(), 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(options.directory, "application.json"))).iconApplied, false);
    assert.deepEqual(await Application.prepare(options, execute), first);
    assert.deepEqual(await Application.prepare(options, execute), first);
    assert.equal(signs, 1); assert.equal(icons, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(options.directory, "application.json"))).iconApplied, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Android application entries reuse one signed launcher and retire renamed bundles", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-entry-"));
  try {
    const jdk = path.join(root, "jdk"), javaPath = path.join(jdk, "bin/java"), directory = path.join(root, "application");
    fs.mkdirSync(path.dirname(javaPath), { recursive: true }); fs.mkdirSync(path.join(jdk, "lib"));
    fs.writeFileSync(javaPath, "owned launcher fixture"); fs.writeFileSync(path.join(jdk, "lib/jspawnhelper"), "original helper");
    const executions = [], execute = async (command, args) => { executions.push({ command, args }); };
    const options = { executablePath: javaPath, links: {lib: path.join(jdk, "lib")}, directory, title: "A & B" };
    const first = await Application.prepare(options, execute), second = await Application.prepare(options, execute);
    assert.deepEqual(second, first); assert.equal(executions.length, 1);
    assert.deepEqual(await Application.prepare({...options, showInDock:false, executableName:"java"}, execute), first);
    assert.equal(executions.length, 1, "Explicit legacy defaults preserve the existing bundle fingerprint");
    const basis = JSON.parse(fs.readFileSync(path.join(directory,"application.json"))).basis;
    assert.equal(Object.hasOwn(basis,"showInDock"),false); assert.equal(Object.hasOwn(basis,"executableName"),false);
    assert.match(fs.readFileSync(path.join(first.app,"Contents/Info.plist"),"utf8"), /<key>LSUIElement<\/key><true\/>/);
    assert.equal(path.basename(first.app), "A & B.app");
    assert.match(fs.readFileSync(path.join(first.app, "Contents/Info.plist"), "utf8"), /A &amp; B/);
    assert.equal(fs.realpathSync(path.join(first.app, "Contents/lib")), fs.realpathSync(path.join(jdk, "lib")));
    assert.equal(executions[0].command, "/usr/bin/codesign"); assert.ok(!executions[0].args.includes("--deep"));
    const renamed = await Application.prepare({ ...options, title: "New Name" }, execute);
    assert.equal(executions.length, 2); assert.equal(path.basename(renamed.app), "New Name.app");
    assert.equal(fs.existsSync(first.app), false);
    assert.deepEqual(fs.readdirSync(directory).sort(), ["New Name.app", "application.json"]);
    assert.equal(fs.readFileSync(path.join(jdk, "lib/jspawnhelper"), "utf8"), "original helper");
    // An older entry used a fixed basename; migration replaces that exact owned entry.
    fs.renameSync(renamed.app, path.join(directory, "Application.app"));
    const receiptFile = path.join(directory, "application.json"), receipt = JSON.parse(fs.readFileSync(receiptFile));
    receipt.basis.layout = 1; receipt.fingerprint = "old"; fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    await Application.prepare({ ...options, title: "New Name" }, execute);
    assert.equal(fs.existsSync(path.join(directory, "Application.app")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Android application executable names stay within the application bundle", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-entry-name-"));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const executable = path.join(root,"native-entry"); fs.writeFileSync(executable,"owned entry");
  for (const executableName of ["", ".", "..", "../outside", "/absolute", "bad\0name", "a".repeat(256), 5])
    await assert.rejects(Application.prepare({executablePath:executable, executableName, directory:path.join(root,"application"), title:"Name"}, async()=>assert.fail("Invalid names are rejected before signing")), /executable names must be filenames/);
});

test("Both execution engines use the same application entry and retire the previous binary", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-vm-entry-"));
  try {
    const java = path.join(root, "java"), native = path.join(root, "android-art-presenter");
    fs.writeFileSync(java, "JVM entry"); fs.writeFileSync(native, "ART entry");
    const options = {directory: path.join(root, "application"), title: "Shared Android identity"};
    const execute = async () => {};
    const jvm = await Application.prepare({...options, executablePath: java}, execute);
    const art = await Application.prepare({...options, executablePath: native}, execute);
    assert.equal(art.app, jvm.app); assert.equal(art.identifier, jvm.identifier);
    assert.equal(fs.existsSync(jvm.executablePath), false);
    assert.equal(fs.readFileSync(art.executablePath, "utf8"), "ART entry");
    assert.match(fs.readFileSync(path.join(art.app, "Contents/Info.plist"), "utf8"), /<key>CFBundleExecutable<\/key><string>android-art-presenter<\/string>/);
    assert.deepEqual(await Application.prepare({...options, executablePath: native}, execute), art);
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
});

test("The shared native application boundary publishes the prepared Dock identity without activation", async t => {
  const sdl = process.env.ANDROID_SDL_FRAMEWORK;
  if (process.platform !== "darwin" || !sdl) return t.skip("Requires the native Android SDL framework");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-native-identity-"));
  try {
    const entry = path.join(root, "native-entry"), icon = path.join(root, "icon.png"), helper = path.join(root, "icon-probe");
    execFileSync("clang", ["-fobjc-arc", "tests/fixtures/android-application-icon/IconProbe.m", "-framework", "AppKit", "-o", helper]);
    execFileSync(helper, ["create", icon]);
    execFileSync("clang++", ["-std=c++20", "-fobjc-arc", "-I" + path.resolve("src/modules/android/native"), "-F" + path.dirname(sdl),
      "tests/fixtures/android-application-icon/ApplicationProbe.mm", "-framework", "SDL3", "-framework", "AppKit", "-framework", "Metal", "-framework", "QuartzCore", "-Wl,-rpath," + path.dirname(sdl), "-o", entry]);
    const title = "Shared Android Native Identity";
    const application = await Application.prepare({executablePath:entry, directory:path.join(root,"application"), title, iconFile:icon});
    assert.match(execFileSync(application.executablePath, [title, icon], {encoding:"utf8", timeout:15000}), /PASS shared native application identity/);
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
});

test("Mac sleep notifications share the existing window event queue and retire with its owner", t => {
  const sdl=process.env.ANDROID_SDL_FRAMEWORK;
  if(process.platform!=="darwin"||!sdl)return t.skip("Requires the native Android SDL framework");
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"android-application-sleep-"));
  try{
    const entry=path.join(root,"sleep-probe");
    execFileSync("clang++",["-std=c++20","-fobjc-arc","-I"+path.resolve("src/modules/android/native"),"-F"+path.dirname(sdl),
      "tests/fixtures/android-application-icon/SleepProbe.mm","src/modules/android/native/application-sleep.mm",
      "-framework","SDL3","-framework","AppKit","-Wl,-rpath,"+path.dirname(sdl),"-o",entry]);
    assert.match(execFileSync(entry,[],{encoding:"utf8",timeout:15000}),/PASS workspace sleep\/wake SDL delivery/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
