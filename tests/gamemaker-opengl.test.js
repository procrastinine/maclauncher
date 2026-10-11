const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Fallback = require("../src/modules/gamemaker/runtime/opengl-fallback");
const Native = require("../src/modules/shared/runtime/local-native");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-opengl-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const nativeArm = process.platform === "darwin" && process.arch === "arm64";

test("OpenGL fallback selection is read-only and restricted to reviewed runner/version pairs", t => {
  const userDataDir = temporary(t);
  for (const runnerVersion of [undefined, "", "2026.0.0.32908", "2026.0.0.24", "2025.11.1.16"]) {
    const result = Fallback.resolveFallback({ userDataDir, runnerVersion });
    assert.equal(result.ready, false);
    assert.equal(result.environment, undefined);
    assert.match(result.reason, /2026\.0\.0\.23/);
  }
  for (const runnerSha256 of [undefined, "", "0".repeat(64)]) {
    const differentBinary = Fallback.resolveFallback({ userDataDir, runnerVersion: "2026.0.0.23", runnerSha256 });
    assert.equal(differentBinary.ready, false);
    assert.equal(differentBinary.environment, undefined);
    assert.match(differentBinary.reason, /checksum/);
  }
  const selected = Fallback.resolveFallback({ userDataDir, runnerVersion: "2026.0.0.23", runnerSha256: Fallback.TESTED_VENDOR_SHA256 });
  assert.equal(selected.ready, false);
  assert.equal(selected.environment, undefined);
  assert.equal(fs.readdirSync(userDataDir).length, 0, "status and selection must not build files");
  assert.equal(Native.hashFile(Fallback.__test.SOURCE_PATH), Fallback.SOURCE_SHA256);
  assert.throws(() => Fallback.__test.installDirectory("relative"), /absolute/);
  const wrongPair = Fallback.resolveFallback({ userDataDir, runnerVersion: "2024.13.1.242", runnerSha256: Fallback.TESTED_VENDOR_SHA256 });
  assert.equal(wrongPair.ready, false); assert.match(wrongPair.reason, /checksum/);
});

const bundled = Fallback.getBundledFallbackStatus();
const bundleTest = { skip: process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch) || !bundled.ready };

test("bundled graphics helper installs offline once for concurrent games and repairs damaged bytes", bundleTest, async t => {
  const userDataDir = temporary(t);
  const installs = await Promise.all(Array.from({ length: 4 }, () => Fallback.installBundledFallback({ userDataDir })));
  for (const installed of installs) {
    assert.equal(installed.ready, true);
    assert.equal(installed.binarySha256, Fallback.BUNDLED_BINARY_SHA256);
    assert.equal(installed.sourceSha256, Fallback.SOURCE_SHA256);
    assert.deepEqual(installed.compilerArgs, bundled.compilerArgs, "bundle installation retains the reviewed build options");
  }
  const directory = Fallback.__test.installDirectory(userDataDir);
  assert.deepEqual(fs.readdirSync(path.dirname(directory)), [Fallback.HELPER_VERSION]);
  const record = fs.readFileSync(path.join(directory, "helper.json"));
  const cached = await Fallback.installBundledFallback({ userDataDir });
  assert.equal(cached.installedFromBundle, undefined);
  assert.deepEqual(fs.readFileSync(path.join(directory, "helper.json")), record);
  fs.appendFileSync(cached.dylibPath, "changed");
  assert.equal(Fallback.getFallbackStatus({ userDataDir }).ready, false);
  const repaired = await Fallback.installBundledFallback({ userDataDir });
  assert.equal(Native.hashFile(repaired.dylibPath), Fallback.BUNDLED_BINARY_SHA256);
  assert.deepEqual(fs.readdirSync(path.dirname(directory)), [Fallback.HELPER_VERSION]);
});

test("changed bundled graphics resources are refused before installation", bundleTest, async t => {
  const root = temporary(t), resourcesRoot = path.join(root, "resources"), userDataDir = path.join(root, "data");
  const directory = path.join(resourcesRoot, Fallback.__test.BUNDLED_RELATIVE);
  fs.mkdirSync(directory, { recursive: true });
  for (const name of bundled.names) fs.copyFileSync(path.join(bundled.directory, name), path.join(directory, name));
  assert.equal(Fallback.getBundledFallbackStatus({ resourcesRoot }).ready, true);
  fs.appendFileSync(path.join(directory, "software-opengl.dylib"), "changed");
  await assert.rejects(Fallback.installBundledFallback({ userDataDir, resourcesRoot }), /changed/);
  assert.equal(fs.existsSync(userDataDir), false);
});

test("missing bundled helper gives a concrete error without creating a partial install", bundleTest, async t => {
  const resourcesRoot = temporary(t), userDataDir = path.join(resourcesRoot, "data");
  await assert.rejects(Fallback.installBundledFallback({ userDataDir, resourcesRoot }), /does not include/);
  assert.equal(fs.existsSync(userDataDir), false);
});

test("native helper builds its pinned source and rejects changed libraries and records", { skip: !nativeArm }, async t => {
  const userDataDir = temporary(t);
  const built = await Fallback.buildFallback({ userDataDir });
  assert.equal(built.ready, true);
  assert.equal(built.version, Fallback.HELPER_VERSION);
  assert.equal(built.sourceSha256, Fallback.SOURCE_SHA256);
  assert.deepEqual(Native.readMachOArchitectures(built.dylibPath, { allowLibrary: true }).sort(), ["arm64", "x86_64"]);
  assert.equal(Native.hashFile(built.dylibPath), built.binarySha256);
  const selection = { userDataDir, runnerVersion: "2026.0.0.23", runnerSha256: Fallback.TESTED_VENDOR_SHA256 };
  const resolved = Fallback.resolveFallback(selection);
  const legacy = Fallback.resolveFallback({ userDataDir, runnerVersion: "2024.13.1.242", runnerSha256: Fallback.TESTED_VENDOR_BUILDS["2024.13.1.242"] });
  assert.equal(legacy.ready, true); assert.equal(legacy.dylibPath, resolved.dylibPath);
  for (const runnerVersion of ["1.4.9999", "2.2.5.378", "2.3.7.476"]) {
    const intel = Fallback.resolveFallback({ userDataDir, runnerVersion, runnerSha256: Fallback.TESTED_VENDOR_BUILDS[runnerVersion] });
    assert.equal(intel.ready, true); assert.equal(intel.dylibPath, resolved.dylibPath);
    const selectedPin = Fallback.HELPER_BUILDS.find(pin => pin.version === Fallback.HELPER_VERSION);
    assert.equal(intel.environment.MACLAUNCHER_LEGACY_LOGICAL_OPENGL, selectedPin.legacyLogicalRunnerVersions.includes(runnerVersion) ? "1" : "0");
  }
  assert.deepEqual(resolved.environment, { DYLD_INSERT_LIBRARIES: built.dylibPath, MACLAUNCHER_ALLOW_SOFTWARE_OPENGL: "1", MACLAUNCHER_LEGACY_LOGICAL_OPENGL: "0" });
  const cached = await Fallback.buildFallback({ userDataDir });
  assert.equal(cached.alreadyBuilt, true);
  assert.equal(cached.builtAt, built.builtAt);

  fs.appendFileSync(built.dylibPath, "replaced library");
  const changed = Fallback.resolveFallback(selection);
  assert.equal(changed.ready, false);
  assert.equal(changed.environment, undefined);
  assert.match(changed.reason, /changed/);
  const repaired = await Fallback.buildFallback({ userDataDir });
  assert.equal(repaired.ready, true, "an explicit build can replace a damaged helper");
  assert.equal(Native.hashFile(repaired.dylibPath), repaired.binarySha256);
  const recordPath = path.join(repaired.installDir, "helper.json");
  const record = JSON.parse(fs.readFileSync(recordPath));
  for (const [key, value] of [["version", "other"], ["sourceSha256", "0".repeat(64)], ["testedVendorSha256", "0".repeat(64)],
    ["architecture", "x86_64"], ["supportedRunnerVersions", ["unreviewed"]]]) {
    fs.writeFileSync(recordPath, JSON.stringify({ ...record, [key]: value }));
    assert.equal(Fallback.getFallbackStatus({ userDataDir }).ready, false);
  }
  fs.writeFileSync(recordPath, JSON.stringify(record));
  assert.equal(Fallback.getFallbackStatus({ userDataDir }).ready, true);
  assert.deepEqual(fs.readdirSync(path.dirname(repaired.installDir)), [Fallback.HELPER_VERSION]);
});

test("legacy graphics coordinates require the reviewed profile, owned view and actual software context", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), source = path.join(root, "logical-contract.m");
  const candidateSource = path.resolve(__dirname, "../src/modules/gamemaker/overlays/software-opengl-v2.m");
  fs.writeFileSync(source, `#include ${JSON.stringify(candidateSource)}
#include <assert.h>
static GLint fixtureRenderer;
static unsigned originalCalls;
@interface FixtureFormat : NSOpenGLPixelFormat @end
@implementation FixtureFormat
- (void)getValues:(GLint *)values forAttribute:(NSOpenGLPixelFormatAttribute)attribute forVirtualScreen:(GLint)screen {
    assert(attribute == NSOpenGLPFARendererID && screen == 0); *values = fixtureRenderer;
}
@end
static FixtureFormat *fixtureFormat;
@interface FixtureContext : NSOpenGLContext @end
@implementation FixtureContext
- (NSOpenGLPixelFormat *)pixelFormat { return fixtureFormat; }
- (GLint)currentVirtualScreen { return 0; }
@end
static FixtureContext *fixtureContext;
@interface YYGLView : NSView @end
@implementation YYGLView
- (NSOpenGLContext *)getContext { return fixtureContext; }
@end
static NSRect originalRect(id receiver, SEL selector, NSRect rect) {
    (void)receiver; (void)selector; originalCalls++;
    return NSMakeRect(rect.origin.x*2, rect.origin.y*2, rect.size.width*2, rect.size.height*2);
}
int main(void) { @autoreleasepool {
    fixtureFormat = [FixtureFormat alloc]; fixtureContext = [FixtureContext alloc];
    YYGLView *view = [[YYGLView alloc] initWithFrame:NSZeroRect];
    NSView *other = [[NSView alloc] initWithFrame:NSZeroRect];
    originalToBacking = originalRect; originalFromBacking = originalRect;
    const NSRect input = NSMakeRect(3,5,640,480), expected = NSMakeRect(6,10,1280,960);
    legacyLogicalRequested = NO; fixtureRenderer = 0x01020400;
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),expected));
    assert(NSEqualRects(convertFromBacking(view,@selector(convertRectFromBacking:),input),expected));
    assert(originalCalls == 2); // Modern/profile-disabled paths retain both real conversions.
    legacyLogicalRequested = YES; fixtureRenderer = 0x01024000;
    assert(!usesLegacySoftwareCoordinates(view));
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),expected));
    fixtureRenderer = 0x01020400;
    assert(!usesLegacySoftwareCoordinates(other));
    assert(NSEqualRects(convertFromBacking(other,@selector(convertRectFromBacking:),input),expected));
    assert(originalCalls == 4); // Hardware and other views retain their original coordinates.
    assert(usesLegacySoftwareCoordinates(view));
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),input));
    assert(NSEqualRects(convertFromBacking(view,@selector(convertRectFromBacking:),input),input));
    assert(originalCalls == 4);
    fixtureContext = nil;
    assert(!usesLegacySoftwareCoordinates(view));
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),expected));
    assert(originalCalls == 5); // Missing/unknown native contexts remain untouched.
    [other release]; [view release];
} return 0; }
`);
  const executable = path.join(root, "logical-contract");
  execFileSync("/usr/bin/clang", ["-Wno-deprecated-declarations", "-framework", "AppKit", source, "-o", executable], { timeout: 30000 });
  const environment = { ...process.env };
  delete environment.MACLAUNCHER_ALLOW_SOFTWARE_OPENGL;
  delete environment.DYLD_INSERT_LIBRARIES;
  execFileSync(executable, [], { env: environment, timeout: 10000 });
});

test("graphics helper versions preserve the immutable earlier source and installation", { skip: process.platform !== "darwin" }, async t => {
  const userDataDir = temporary(t), helperVersion = "software-gl-v1-universal";
  const oldBundle = Fallback.getBundledFallbackStatus({ helperVersion });
  if (!oldBundle.ready) return t.skip("Historical reviewed resource bundle unavailable");
  assert.equal(Fallback.HELPER_BUILDS.length, 5);
  const old = await Fallback.installBundledFallback({ userDataDir, helperVersion });
  const record = fs.readFileSync(path.join(old.installDir, "helper.json"));
  const legacy = Fallback.resolveFallback({ userDataDir, helperVersion, runnerVersion: "1.4.9999", runnerSha256: Fallback.TESTED_VENDOR_BUILDS["1.4.9999"] });
  assert.equal(legacy.version, helperVersion);
  assert.equal(legacy.environment.MACLAUNCHER_LEGACY_LOGICAL_OPENGL, "0");
  assert.deepEqual(fs.readFileSync(path.join(old.installDir, "helper.json")), record);
  assert.equal(Fallback.getFallbackStatus({ userDataDir, helperVersion: "software-gl-v2-universal" }).ready, false, "Earlier installation cannot impersonate the new helper version");
  assert.throws(() => Fallback.resolveFallback({ userDataDir, helperVersion: "latest" }), /listed graphics helper version/);
});

test("V3 selects actual fallback software once and preserves hardware, modern and pre-attachment behavior", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), source = path.join(root, "v3-native-contract.m");
  fs.writeFileSync(source, `#include ${JSON.stringify(path.resolve(__dirname, "../src/modules/gamemaker/overlays/software-opengl-v3.m"))}
#include <assert.h>
static GLint renderer, accelerated;
static unsigned formatQueries, attempts, originalCalls;
static BOOL failFirst;
@interface FixtureFormat : NSOpenGLPixelFormat @end
@implementation FixtureFormat
- (GLint)numberOfVirtualScreens { return 1; }
- (void)getValues:(GLint *)value forAttribute:(NSOpenGLPixelFormatAttribute)attribute forVirtualScreen:(GLint)screen {
    assert(screen == 0); formatQueries++;
    if (attribute == NSOpenGLPFARendererID) *value = renderer;
    else { assert(attribute == NSOpenGLPFAAccelerated); *value = accelerated; }
}
@end
// Context is intentionally absent: the actual runner selects its pixel format
// before the first conversion, then attaches a context to the view afterwards.
@interface YYGLView : NSView @end
@implementation YYGLView @end
static id initialize(id receiver, SEL selector, const NSOpenGLPixelFormatAttribute *attrs) {
    (void)selector; (void)attrs;
    if (failFirst && attempts++ == 0) { [receiver release]; return nil; }
    return receiver;
}
static NSRect backing(id receiver, SEL selector, NSRect rect) {
    (void)receiver; (void)selector; originalCalls++;
    return NSMakeRect(rect.origin.x*2,rect.origin.y*2,rect.size.width*2,rect.size.height*2);
}
int main(void) { @autoreleasepool {
    const NSOpenGLPixelFormatAttribute attrs[] = {NSOpenGLPFAAccelerated,NSOpenGLPFAColorSize,24,0};
    const NSRect input = NSMakeRect(3,5,640,480), scaled = NSMakeRect(6,10,1280,960);
    YYGLView *view = [[YYGLView alloc] initWithFrame:NSZeroRect];
    NSView *other = [[NSView alloc] initWithFrame:NSZeroRect];
    originalInitializer = initialize; originalToBacking = backing; originalFromBacking = backing;
    legacyLogicalRequested = YES; softwareFallbackSelected = NO;
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),scaled));
    assert(formatQueries == 0 && originalCalls == 1); // Before format selection, native units stay intact.
    failFirst = NO; attempts = 0; renderer = 0x01024000; accelerated = 1;
    id format = initializePixelFormat([FixtureFormat alloc],@selector(initWithAttributes:),attrs);
    assert(format && !softwareFallbackSelected && formatQueries == 0);
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),scaled));
    [format release]; // A successful hardware request never selects logical units.
    failFirst = YES; attempts = 0; renderer = 0x01020400; accelerated = 0;
    format = initializePixelFormat([FixtureFormat alloc],@selector(initWithAttributes:),attrs);
    assert(format && softwareFallbackSelected && formatQueries == 2);
    assert(![view respondsToSelector:sel_registerName("getContext")]);
    for (int i = 0; i < 8; i++) {
        assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),input));
        assert(NSEqualRects(convertFromBacking(view,@selector(convertRectFromBacking:),input),input));
    }
    assert(formatQueries == 2 && originalCalls == 18); // No per-frame GL/format query, originals still evaluated.
    assert(NSEqualRects(convertToBacking(other,@selector(convertRectToBacking:),input),scaled));
    assert(originalCalls == 19); [format release];
    legacyLogicalRequested = NO; softwareFallbackSelected = NO; formatQueries = 0; attempts = 0;
    format = initializePixelFormat([FixtureFormat alloc],@selector(initWithAttributes:),attrs);
    assert(format && !softwareFallbackSelected && formatQueries == 0);
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),scaled));
    [format release]; // Modern/profile-disabled software requests keep native conversions.
    legacyLogicalRequested = YES; attempts = 0; renderer = 0x01024000; accelerated = 1;
    format = initializePixelFormat([FixtureFormat alloc],@selector(initWithAttributes:),attrs);
    assert(format && !softwareFallbackSelected);
    assert(NSEqualRects(convertFromBacking(view,@selector(convertRectFromBacking:),input),scaled));
    [format release]; // A retry that chooses hardware is not a software qualification.
    softwareFallbackSelected = YES; failFirst = NO; attempts = 0;
    format = initializePixelFormat([FixtureFormat alloc],@selector(initWithAttributes:),attrs);
    assert(format && !softwareFallbackSelected); [format release];
    [other release]; [view release];
} return 0; }
`);
  const executable = path.join(root, "v3-native-contract");
  execFileSync("/usr/bin/clang", ["-Wno-deprecated-declarations", "-framework", "AppKit", source, "-o", executable], { timeout: 30000 });
  const environment = { ...process.env };
  delete environment.MACLAUNCHER_ALLOW_SOFTWARE_OPENGL;
  delete environment.DYLD_INSERT_LIBRARIES;
  execFileSync(executable, [], { env: environment, timeout: 10000 });
});

test("V3 installation is independent of sealed V1/V2 and its legacy opt-in requires the reviewed runner", { skip: process.platform !== "darwin" }, async t => {
  const userDataDir = temporary(t);
  const versions = ["software-gl-v1-universal", "software-gl-v2-universal", "software-gl-v3-universal"];
  const snapshots = new Map();
  for (const helperVersion of versions) {
    const bundle = Fallback.getBundledFallbackStatus({ helperVersion });
    if (!bundle.ready) return t.skip(`Exact ${helperVersion} source/resource unavailable`);
    const installed = await Fallback.installBundledFallback({ userDataDir, helperVersion });
    snapshots.set(helperVersion, fs.readFileSync(path.join(installed.installDir, "helper.json")));
    assert.equal(installed.binarySha256, Fallback.HELPER_BUILDS.find(pin => pin.version === helperVersion).binarySha256);
  }
  for (const helperVersion of versions) {
    const installed = Fallback.getFallbackStatus({ userDataDir, helperVersion });
    assert.deepEqual(fs.readFileSync(path.join(installed.installDir, "helper.json")), snapshots.get(helperVersion));
  }
  const helperVersion = "software-gl-v3-universal";
  const legacy = Fallback.resolveFallback({ userDataDir, helperVersion, runnerVersion: "1.4.9999", runnerSha256: Fallback.TESTED_VENDOR_BUILDS["1.4.9999"] });
  assert.equal(legacy.environment.MACLAUNCHER_LEGACY_LOGICAL_OPENGL, "1");
  const modern = Fallback.resolveFallback({ userDataDir, helperVersion, runnerVersion: "2026.0.0.23", runnerSha256: Fallback.TESTED_VENDOR_BUILDS["2026.0.0.23"] });
  assert.equal(modern.environment.MACLAUNCHER_LEGACY_LOGICAL_OPENGL, "0");
  assert.equal(Fallback.resolveFallback({ userDataDir, helperVersion, runnerVersion: "1.4.9999", runnerSha256: Fallback.TESTED_VENDOR_SHA256 }).ready, false);
});

test("failed build directory setup releases the process-local build lock", { skip: !nativeArm }, async t => {
  const root = temporary(t);
  const userDataDir = path.join(root, "blocked");
  fs.writeFileSync(userDataDir, "not a directory");
  await assert.rejects(() => Fallback.buildFallback({ userDataDir }), /EEXIST|ENOTDIR/);
  await assert.rejects(() => Fallback.buildFallback({ userDataDir }), /EEXIST|ENOTDIR/);
});

test("pixel retry keeps profiles, recovery and buffer values, and uses a fresh receiver after failed init", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t);
  const source = path.join(root, "pixel-contract.m");
  // Include the real overlay so its parser and initializer contract are tested.
  // No enabling environment is set: AppKit itself is not swizzled in this test.
  fs.writeFileSync(source, `#include ${JSON.stringify(Fallback.__test.SOURCE_PATH)}
#include <assert.h>
@interface PixelTestReceiver : NSObject
@end
@implementation PixelTestReceiver
@end
static unsigned attempts;
static BOOL failFirst;
static NSOpenGLPixelFormatAttribute captured[2][65];
static id mockInitializer(id receiver, SEL selector, const NSOpenGLPixelFormatAttribute *attrs) {
    (void)selector;
    unsigned n = attempts++;
    assert(n < 2);
    unsigned i = 0;
    do { captured[n][i] = attrs[i]; } while (attrs[i++] && i < 65);
    if (failFirst && n == 0) { [receiver release]; return nil; }
    return receiver;
}
int main(void) {
    @autoreleasepool {
        const NSOpenGLPixelFormatAttribute exact[] = {72,73,99,4096,5,8,24,11,8,12,24,13,8,0};
        const NSOpenGLPixelFormatAttribute expected[] = {72,99,4096,5,8,24,11,8,12,24,13,8,0};
        NSOpenGLPixelFormatAttribute copied[65];
        assert(copySoftwareEligibleAttributes(exact, copied));
        assert(memcmp(copied, expected, sizeof(expected)) == 0);
        const NSOpenGLPixelFormatAttribute value73[] = {8,73,73,0};
        const NSOpenGLPixelFormatAttribute keptValue[] = {8,73,0};
        assert(copySoftwareEligibleAttributes(value73, copied));
        assert(memcmp(copied, keptValue, sizeof(keptValue)) == 0);
        const NSOpenGLPixelFormatAttribute noAccel[] = {99,0x4100,5,0};
        assert(!copySoftwareEligibleAttributes(noAccel, copied));
        const NSOpenGLPixelFormatAttribute unknown[] = {999,73,0};
        assert(!copySoftwareEligibleAttributes(unknown, copied));
        NSOpenGLPixelFormatAttribute noTerminator[64];
        for (unsigned i = 0; i < 64; i++) noTerminator[i] = NSOpenGLPFAAccelerated;
        assert(!copySoftwareEligibleAttributes(noTerminator, copied));
        assert(!copySoftwareEligibleAttributes(NULL, copied));

        originalInitializer = mockInitializer;
        failFirst = NO; attempts = 0;
        id receiver = [PixelTestReceiver alloc];
        id result = initializePixelFormat(receiver, @selector(initWithAttributes:), exact);
        assert(result == receiver && attempts == 1);
        assert(memcmp(captured[0], exact, sizeof(exact)) == 0);
        [result release];

        failFirst = YES; attempts = 0;
        result = initializePixelFormat([PixelTestReceiver alloc], @selector(initWithAttributes:), exact);
        assert(result && object_getClass(result) == [PixelTestReceiver class] && attempts == 2);
        assert(memcmp(captured[0], exact, sizeof(exact)) == 0);
        assert(memcmp(captured[1], expected, sizeof(expected)) == 0);
        [result release];

        attempts = 0;
        assert(initializePixelFormat([PixelTestReceiver alloc], @selector(initWithAttributes:), noAccel) == nil);
        assert(attempts == 1);
        attempts = 0;
        assert(initializePixelFormat([PixelTestReceiver alloc], @selector(initWithAttributes:), unknown) == nil);
        assert(attempts == 1);
    }
    return 0;
}`);
  const executable = path.join(root, "pixel-contract");
  execFileSync("/usr/bin/clang", ["-Wno-deprecated-declarations", "-framework", "AppKit", source, "-o", executable], { timeout: 30000 });
  const environment = { ...process.env };
  delete environment.MACLAUNCHER_ALLOW_SOFTWARE_OPENGL;
  delete environment.DYLD_INSERT_LIBRARIES;
  execFileSync(executable, [], { env: environment, timeout: 10000 });
});
