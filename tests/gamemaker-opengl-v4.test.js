const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Native = require('../src/modules/shared/runtime/local-native');
const Fallback = require('../src/modules/gamemaker/runtime/opengl-fallback');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maclauncher-opengl-v4-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('V4 retains software context selection across unrelated formats and native view/context lifecycles', { skip: process.platform !== 'darwin' }, t => {
  const root = temporary(t), source = path.join(root, 'native-lifecycle.m');
  fs.writeFileSync(source, `#include ${JSON.stringify(path.resolve(__dirname, '../src/modules/gamemaker/overlays/software-opengl-v4.m'))}
#include <assert.h>
static GLint renderer = kCGLRendererGenericFloatID, accelerated;
static unsigned formatQueries, formatAttempts, contextAttempts, originalCalls, getterCalls;
static BOOL failFirst, failContext;
static id lastShareContext;
@interface FixtureFormat : NSOpenGLPixelFormat @end
@implementation FixtureFormat
- (GLint)numberOfVirtualScreens { return 1; }
- (void)getValues:(GLint *)value forAttribute:(NSOpenGLPixelFormatAttribute)attribute forVirtualScreen:(GLint)screen {
    assert(screen == 0); formatQueries++;
    if (attribute == NSOpenGLPFARendererID) *value = renderer;
    else { assert(attribute == NSOpenGLPFAAccelerated); *value = accelerated; }
}
@end
@interface FixtureContext : NSOpenGLContext @end
@implementation FixtureContext
- (NSOpenGLPixelFormat *)pixelFormat { assert(!"Rendering must not query the context's pixel format"); return nil; }
- (GLint)currentVirtualScreen { assert(!"Rendering must not query the context's virtual screen"); return 0; }
@end
@interface YYGLView : NSView { @public id fixtureContext; } @end
@implementation YYGLView
- (NSOpenGLContext *)getContext { getterCalls++; return fixtureContext; }
@end
@interface DerivedYYGLView : YYGLView @end
@implementation DerivedYYGLView @end
static id formatInitializer(id receiver, SEL selector, const NSOpenGLPixelFormatAttribute *attrs) {
    (void)selector; (void)attrs;
    if (failFirst && formatAttempts++ == 0) { [receiver release]; return nil; }
    return receiver;
}
static id contextInitializer(id receiver, SEL selector, NSOpenGLPixelFormat *format, NSOpenGLContext *share) {
    (void)selector; (void)format; lastShareContext = share; contextAttempts++;
    if (failContext) { [receiver release]; return nil; }
    return receiver;
}
static NSRect backing(id receiver, SEL selector, NSRect rect) {
    (void)receiver; (void)selector; originalCalls++;
    return NSMakeRect(rect.origin.x*2,rect.origin.y*2,rect.size.width*2,rect.size.height*2);
}
static id makeFormat(BOOL fail) {
    const NSOpenGLPixelFormatAttribute attrs[] = {NSOpenGLPFAAccelerated,NSOpenGLPFAColorSize,24,0};
    failFirst = fail; formatAttempts = 0;
    return initializePixelFormat([FixtureFormat alloc],@selector(initWithAttributes:),attrs);
}
static id makeContext(id format) {
    return initializeContext([FixtureContext alloc],@selector(initWithFormat:shareContext:),format,nil);
}
int main(void) { @autoreleasepool {
    originalInitializer = formatInitializer; originalContextInitializer = contextInitializer;
    originalToBacking = backing; originalFromBacking = backing; legacyLogicalRequested = YES;
    const NSRect input = NSMakeRect(3,5,640,480), scaled = NSMakeRect(6,10,1280,960);
    YYGLView *view = [[YYGLView alloc] initWithFrame:NSZeroRect];
    YYGLView *other = [[YYGLView alloc] initWithFrame:NSZeroRect];
    NSView *ordinary = [[NSView alloc] initWithFrame:NSZeroRect];
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),scaled));
    assert(originalCalls == 1 && formatQueries == 0); // No selection exists yet.

    id softwareFormat = makeFormat(YES);
    assert(softwareFormat && formatQueries == 2);
    assert([objc_getAssociatedObject(softwareFormat,&softwareFormatKey) boolValue]);
    id softwareContext = makeContext(softwareFormat);
    assert(softwareContext && contextAttempts == 1);
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),input));
    assert(NSEqualRects(convertFromBacking(other,@selector(convertRectFromBacking:),input),scaled));
    assert(NSEqualRects(convertToBacking(ordinary,@selector(convertRectToBacking:),input),scaled));
    assert(originalCalls == 4); // Only the runner's first pre-attachment view borrows the selection.

    view->fixtureContext = softwareContext;
    assert(NSEqualRects(convertFromBacking(view,@selector(convertRectFromBacking:),input),input));
    assert(![pendingSoftwareFormats anyObject]); // The provisional format reached its real view.
    renderer = 0x01024000; accelerated = 1;
    id hardwareFormat = makeFormat(NO), hardwareContext = makeContext(hardwareFormat);
    assert(formatQueries == 2); // A successful unrelated format is not queried or globally reset.
    assert(![objc_getAssociatedObject(hardwareFormat,&softwareFormatKey) boolValue]);
    assert(![objc_getAssociatedObject(hardwareContext,&softwareContextKey) boolValue]);
    id hardwareSharedContext = initializeContext([FixtureContext alloc],@selector(initWithFormat:shareContext:),hardwareFormat,softwareContext);
    assert(lastShareContext == softwareContext);
    assert(![objc_getAssociatedObject(hardwareSharedContext,&softwareContextKey) boolValue]);
    [hardwareSharedContext release]; // Sharing a software context does not change this hardware format.
    other->fixtureContext = hardwareContext;
    unsigned before = originalCalls;
    for (int i = 0; i < 100; i++) {
        assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),input));
        assert(NSEqualRects(convertFromBacking(view,@selector(convertRectFromBacking:),input),input));
        assert(NSEqualRects(convertToBacking(other,@selector(convertRectToBacking:),input),scaled));
    }
    assert(formatQueries == 2 && originalCalls == before + 300);
    // A later successful pixel initializer reproduces V3's reset trigger, but
    // cannot change this actual selected context, even after many conversions.
    id unrelatedFormat = makeFormat(NO);
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),input));
    assert(formatQueries == 2);

    view->fixtureContext = hardwareContext;
    assert(NSEqualRects(convertFromBacking(view,@selector(convertRectFromBacking:),input),scaled));
    view->fixtureContext = nil;
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),scaled));
    view->fixtureContext = softwareContext;
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),input));
    [softwareContext release]; view->fixtureContext = nil;
    assert(NSEqualRects(convertFromBacking(view,@selector(convertRectFromBacking:),input),scaled));
    // Destroyed contexts are held weakly; a new unknown context is not allowed
    // to inherit the old address/cache or the old format's software selection.
    id unknownContext = [FixtureContext alloc]; view->fixtureContext = unknownContext;
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),scaled));
    [unknownContext release]; view->fixtureContext = nil;

    failContext = YES; assert(!makeContext(softwareFormat)); failContext = NO;
    accelerated = 0; renderer = kCGLRendererGenericFloatID;
    id originalSoftwareFormat = makeFormat(NO), originalSoftwareContext = makeContext(originalSoftwareFormat);
    view->fixtureContext = originalSoftwareContext;
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),scaled));
    assert(formatQueries == 2); // A working original request retains AppKit, even if software.
    accelerated = 1; renderer = 0x01024000;
    id retryHardwareFormat = makeFormat(YES), retryHardwareContext = makeContext(retryHardwareFormat);
    view->fixtureContext = retryHardwareContext;
    assert(NSEqualRects(convertFromBacking(view,@selector(convertRectFromBacking:),input),scaled));
    assert(formatQueries == 4); // A fallback choosing hardware is not eligible.

    legacyLogicalRequested = NO; accelerated = 0; renderer = kCGLRendererGenericFloatID;
    id modernFormat = makeFormat(YES), modernContext = makeContext(modernFormat);
    view->fixtureContext = modernContext;
    assert(NSEqualRects(convertToBacking(view,@selector(convertRectToBacking:),input),scaled));
    assert(formatQueries == 4); // Modern/profile-disabled fallback does not inspect or change units.
    [modernContext release]; [modernFormat release];
    [retryHardwareContext release]; [retryHardwareFormat release];
    [originalSoftwareContext release]; [originalSoftwareFormat release];
    [hardwareContext release]; [hardwareFormat release]; [unrelatedFormat release];
    [softwareFormat release];
    view->fixtureContext = nil; other->fixtureContext = nil;
    [view release]; [other release]; [ordinary release];
    printf("{\\"formatQueries\\":%u,\\"originalConversions\\":%u,\\"contextInitializers\\":%u,\\"stableGetterCalls\\":%u,\\"lifecyclePassed\\":true}\\n",formatQueries,originalCalls,contextAttempts,getterCalls);
}
    // Foundation weak-table lookups can temporarily autorelease-retain their
    // returned object. Drain the fixture's pool before checking final lifetime.
    assert(![provisionalViews anyObject]);
    [pendingSoftwareFormats release]; [provisionalViews release];
    return 0;
}
`);
  const executable = path.join(root, 'native-lifecycle');
  execFileSync('/usr/bin/clang', ['-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=13.0', '-Wno-deprecated-declarations', '-framework', 'AppKit', source, '-o', executable], { timeout: 30000 });
  assert.deepEqual(Native.readMachOArchitectures(executable).sort(), ['arm64', 'x86_64']);
  const environment = { ...process.env };
  delete environment.MACLAUNCHER_ALLOW_SOFTWARE_OPENGL;
  delete environment.MACLAUNCHER_LEGACY_LOGICAL_OPENGL;
  delete environment.DYLD_INSERT_LIBRARIES;
  const architectures = process.arch === 'arm64' ? ['arm64', 'x86_64'] : ['x86_64'];
  for (const architecture of architectures) {
    const output = execFileSync('/usr/bin/arch', [`-${architecture}`, executable], { env: environment, timeout: 10000, encoding: 'utf8' });
    const receipt = JSON.parse(output);
    assert.equal(receipt.lifecyclePassed, true);
    assert.equal(receipt.formatQueries, 4);
    assert.equal(receipt.originalConversions, 314);
  }
});

test('V4 graphics selection has a distinct pin while earlier sealed builds remain explicit', t => {
  const builds = Fallback.HELPER_BUILDS;
  const versions = builds.map(item => item.version);
  assert.equal(new Set(versions).size, versions.length);
  for (const [version, source, binary, manifest] of [
    ['software-gl-v1-universal', '37e4954370bfcd7c17e8c49eed6a59011ba092f17e688bdf7de7e97202912ba0', '2b843ebebde10b9b7fcb592be943e65bfef6cfd2cc34bbbb3dae0dd390c71635', 'c145b4680b092c37d23406df762b51a99b9be791a87e69faf68ab7c312fe8b30'],
    ['software-gl-v2-universal', '08bc3b3f878b52486e480d824262c5b056f6214a4bee72bfcde5516f4aa335ba', 'f630ae3e3c77e6aaea65a0eb90c659dffb6bb3f6f1510a4e2b5a38b32c05f2cb', '4961d9c10b583318c0a0273545dcc19fa2abc61a20540b145088576245495b98'],
    ['software-gl-v3-universal', '7b9e4779af97a2bd7d5f2dd5c1a643ebc9eabc864e649940b294b05d0724c994', '0249adee6d15ef62abc0518c3530a7959a883de322a3143fa8c587e769562616', 'e7bee537ce01d5baf84f6abebc0fa2740003b79653f12587a38a03a59fd5f574']
  ]) {
    const pin = builds.find(item => item.version === version);
    assert.deepEqual([pin.sourceSha256, pin.binarySha256, pin.manifestSha256], [source, binary, manifest]);
    assert.equal(Fallback.__test.sourceIdentity(version), source);
  }
  const pin = builds.find(item => item.version === 'software-gl-v4-universal');
  if (!pin) return t.skip('V4 candidate is not sealed yet');
  assert.equal(pin.sourceFile, 'software-opengl-v4.m');
  assert.deepEqual(pin.legacyLogicalRunnerVersions, ['1.4.9999']);
  assert.equal(Fallback.__test.sourceIdentity(pin.version), pin.sourceSha256);
  assert.notEqual(pin.binarySha256, builds.find(item => item.version === 'software-gl-v3-universal').binarySha256);
});

test('V4 installs and repairs its exact offline bundle independently of existing V3', { skip: process.platform !== 'darwin' }, async t => {
  const userDataDir = temporary(t), helperVersion = 'software-gl-v4-universal';
  const previous = Fallback.getBundledFallbackStatus({ helperVersion: 'software-gl-v3-universal' });
  const bundle = Fallback.getBundledFallbackStatus({ helperVersion });
  if (!previous.present && !previous.ready || !bundle.present && !bundle.ready) return t.skip('Native resources are not staged in this checkout');
  assert.equal(previous.ready, true, previous.reason);
  assert.equal(bundle.ready, true, bundle.reason);
  const old = await Fallback.installBundledFallback({ userDataDir, helperVersion: previous.version });
  const oldFiles = new Map(fs.readdirSync(old.installDir).map(name => [name, Native.hashFile(path.join(old.installDir, name))]));
  const installed = await Fallback.installBundledFallback({ userDataDir, helperVersion });
  const pin = Fallback.HELPER_BUILDS.find(item => item.version === helperVersion);
  assert.equal(installed.version, helperVersion);
  assert.equal(installed.binarySha256, pin.binarySha256);
  assert.equal(installed.sourceSha256, pin.sourceSha256);
  assert.deepEqual(installed.compilerArgs, bundle.compilerArgs);
  const selection = Fallback.resolveFallback({ userDataDir, helperVersion, runnerVersion: '1.4.9999', runnerSha256: Fallback.TESTED_VENDOR_BUILDS['1.4.9999'] });
  assert.equal(selection.ready, true);
  assert.equal(selection.environment.DYLD_INSERT_LIBRARIES, installed.dylibPath);
  assert.equal(selection.environment.MACLAUNCHER_LEGACY_LOGICAL_OPENGL, '1');
  assert.notEqual(installed.installDir, old.installDir);
  fs.appendFileSync(installed.dylibPath, 'changed');
  assert.equal(Fallback.getFallbackStatus({ userDataDir, helperVersion }).ready, false);
  const repaired = await Fallback.installBundledFallback({ userDataDir, helperVersion });
  assert.equal(Native.hashFile(repaired.dylibPath), pin.binarySha256);
  for (const [name, digest] of oldFiles) assert.equal(Native.hashFile(path.join(old.installDir, name)), digest);
  assert.equal(Native.hashFile(path.join(bundle.directory, 'software-opengl.dylib')), pin.binarySha256);
});
