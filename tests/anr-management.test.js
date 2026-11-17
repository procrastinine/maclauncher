const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), zlib = require('node:zlib');
const Manager = require('../src/modules/shared/reshade/runtime/anr-manager');
const Library = Manager.core, Source = Library.Source;
const Github = require('../src/modules/shared/runtime/github-releases');
const Provider = require('../src/modules/shared/reshade/generation/anr');
const Custom = require('../src/modules/shared/runtime/custom-runtime');
const Origins = require('../src/core/runtime-install-origins');
const {runRuntimeManagerAction} = require('../src/core/runtime-manager-service');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const B14 = 'FG-V.B14', B15 = Source.version, OTHER = 'c'.repeat(64);

function context(t) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anr-managed-'));
  t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
  t.mock.method(Provider, 'resolve', () => ({directory: '/provider', library: '/provider/lib.dylib', converterTool: '/provider/convert', verifyTool: '/provider/verify'}));
  return {userDataDir, root: '/selected/graphics'};
}
function releases(t) {
  let requests = 0;
  const asset = (tag, name, size, digest) => ({id: size, name, size, digest: 'sha256:' + digest,
    browser_download_url: `https://github.com/apex-compute/ANR/releases/download/${tag}/${name}`});
  const rows = [
    {tag_name: 'FG-V.B18', assets: [asset('FG-V.B18', 'anr-fg-V.B18-kit-windows.zip', 594572923, 'a'.repeat(64))]},
    {tag_name: B15, assets: [asset(B15, 'anr-fg-V.B15-kit-macos.tar.gz', Source.bytes, Source.sha256), asset(B15, 'anr-fg-V.B15-kit-linux.tar.gz', 570335862, 'b'.repeat(64))]},
    {tag_name: B14, assets: [asset(B14, 'anr-fg-V.B14-kit-macos.tar.gz', 466791152, OTHER)]}];
  t.mock.method(Github, 'fetchGithubTags', async () => { requests++; return rows.map(row => ({name: row.tag_name, commit: {sha: 'd'.repeat(40)}})); });
  t.mock.method(Github, 'fetchGithubReleases', async () => { requests++; return rows.map(row => ({...row,
    html_url: 'https://github.com/apex-compute/ANR/releases/tag/' + row.tag_name})); });
  return {rows, requests: () => requests};
}
// A prepared model directory with a passing receipt, as preparation writes it.
function prepared(directory, version, {checkpoint = version === B15 ? Source.checkpoint : 'checkpoint-' + version, kernelPack = version === B15 ? Source.kernelPack : 'e'.repeat(64)} = {}) {
  fs.mkdirSync(directory, {recursive: true});
  const sizes = {};
  for (const spec of Source.sizes) {
    const target = path.join(directory, spec.id);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'weights.bin'), 'fixture');
    const manifest = Buffer.from(JSON.stringify({schema: 'fsr4_anr_runtime_v1', release: version, checkpoint_id: checkpoint, source_kernel_pack_sha256: kernelPack,
      width: spec.width, height: spec.height, files: {'weights.bin': {bytes: 7}}}));
    fs.writeFileSync(path.join(target, 'manifest.json'), manifest);
    sizes[spec.id] = {width: spec.width, height: spec.height, manifestSha256: sha(manifest),
      parity: [{verified: true, psnr: 90, bar: 80}, {verified: true, psnr: 90, bar: 81}]};
  }
  fs.writeFileSync(path.join(directory, 'runtime.json'), JSON.stringify({schema: 1, version, checkpoint, kernelPack, verified: true, sizes}));
  return directory;
}
const install = (ctx, version, options) => prepared(Library.directory(ctx.userDataDir, version), version, options);

test('ANR Refresh lists every upstream release with a macOS kit, newest first, by its GitHub digest', async t => {
  const ctx = context(t), source = releases(t);
  const catalog = await Manager.refreshCatalog(ctx);
  assert.deepEqual(catalog.versions, [B15, B14], 'a release without a macOS kit is not listed');
  assert.equal(source.requests(), 2);
  const listed = Library.Releases.sources(ctx.userDataDir);
  assert.equal(listed.find(row => row.version === B14).archiveSha256, OTHER);
  assert.equal(listed.find(row => row.version === B15).archiveSha256, Source.sha256);
  const state = Manager.getState(ctx);
  assert.equal(state.supportsDefault, true);
  assert.deepEqual(state.catalog.installableVersions, [B15, B14]);
  assert.equal(source.requests(), 2, 'state reads the cached list offline');
  const plan = Manager.launchPlan(ctx);
  assert.equal(plan.version, B15);assert.equal(plan.automatic, true);assert.equal(plan.bytes, Source.bytes);
  // A listed declared release whose digest changed is not offered.
  source.rows[1].assets[0].digest = 'sha256:' + OTHER;
  await Manager.refreshCatalog(ctx);
  assert.deepEqual(Library.Releases.sources(ctx.userDataDir).map(row => row.version), [B14]);
});

test('ANR defaults: a ready installed version needs no download, a saved default wins once installed, Set default and clearing it work', async t => {
  const ctx = context(t);releases(t);await Manager.refreshCatalog(ctx);
  install(ctx, B14);
  assert.equal(Library.read(ctx.userDataDir, B14).ready, true, 'a listed release other than the declared one is read with its own checkpoint');
  assert.equal(Manager.selection(ctx).version, B14);
  assert.equal(Manager.launchPlan(ctx), null, 'an installed usable version asks for no download');
  const saved = Manager.applySettingsUpdate('setDefault', {version: B15}, {});
  assert.equal(saved.defaultVersion, B15);
  assert.equal(Manager.selection({...ctx, settings: saved}).version, B14, 'an uninstalled saved default gives way to an installed version');
  assert.equal(Manager.getState({...ctx, settings: saved}).defaultSource, 'saved');
  const removed = Manager.selection({...ctx, settings: {defaultVersion: 'FG-V.B01'}});
  assert.equal(removed.version, B14, 'a saved default upstream no longer lists gives way');
  const explicit = Manager.launchPlan({...ctx, settings: saved, version: B15});
  assert.equal(explicit.version, B15);assert.equal(explicit.automatic, false);
  install(ctx, B15);
  assert.equal(Manager.selection({...ctx, settings: {defaultVersion: B14}}).current.version, B14);
  assert.equal(Manager.selection({...ctx, settings: {runtimes: {anr: {defaultVersion: B14}}}}).current.version, B14);
  assert.equal(Manager.selection(ctx).current.version, B15, 'without a saved default the newest installed version is used');
  assert.equal(Manager.applySettingsUpdate('setDefault', {version: null}, saved).defaultVersion, null);
  let leased = 0;
  const used = await Manager.installRuntime({...ctx, settings: {defaultVersion: B14}, useRuntime: async lease => { leased++;assert.equal(lease.version, B14); },
    confirmRuntimeInstall: () => { throw Error('consent must not run'); }});
  assert.equal(used.version, B14);assert.equal(leased, 1);
  await Manager.uninstallRuntime({...ctx, version: B14});
  assert.equal(Library.read(ctx.userDataDir, B14), null);assert.equal(Library.read(ctx.userDataDir, B15).ready, true);
});

test('ANR custom registers a prepared model directory in place and rejects one that changed', async t => {
  const ctx = context(t);
  const runtimePath = prepared(fs.mkdtempSync(path.join(os.tmpdir(), 'anr-custom-')), B14);
  t.after(() => fs.rmSync(runtimePath, {recursive: true, force: true}));
  const registered = await Custom.register(Manager, {...ctx, runtimePath});
  assert.equal(registered.ready, true);assert.equal(registered.custom, true);
  const settings = {customDefaults: {default: runtimePath}};
  const selected = Manager.selection({...ctx, settings});
  assert.equal(selected.current.runtimePath, runtimePath);assert.equal(selected.automatic, false);
  assert.equal(Manager.launchPlan({...ctx, settings}), null);
  fs.writeFileSync(path.join(runtimePath, '1440p/manifest.json'), 'changed');
  assert.throws(() => Manager.customRuntime.inspect(runtimePath), /prepared Apex Neural Rendering model directory/);
  assert.throws(() => Manager.customRuntime.inspect(ctx.userDataDir), /prepared Apex Neural Rendering model directory/);
});

test('ANR automatic Play installs are recorded, explicit choices clear them, and a newer copy retires the older automatic one', async t => {
  const ctx = context(t);releases(t);await Manager.refreshCatalog(ctx);
  const plan = Manager.launchPlan(ctx);
  assert.equal(plan.automatic, true);
  // The automatic copy Play installed, recorded the same way runtime preparation records it.
  const result = install(ctx, B14) && Library.read(ctx.userDataDir, B14);
  assert.equal(Origins.recordPlayInstall({userDataDir: ctx.userDataDir, manager: Manager, plan: {...plan, version: B14}, result, settings: {}}), true);
  assert.deepEqual(Origins.read(ctx.userDataDir).map(row => [row.managerId, row.version]), [['anr', B14]]);
  let settings = {};
  await runRuntimeManagerAction({manager: Manager, action: 'setDefault', payload: {version: B14}, userDataDir: ctx.userDataDir,
    readSettings: () => settings, saveSettings: next => { settings = next; }});
  assert.equal(settings.defaultVersion, B14);
  assert.deepEqual(Origins.read(ctx.userDataDir), [], 'Set default makes the version user-owned');
  assert.equal(Origins.recordPlayInstall({userDataDir: ctx.userDataDir, manager: Manager, plan: {...plan, version: B14}, result, settings: {}}), true);
  install(ctx, B15);
  const removed = [];
  await Origins.pruneSuperseded({userDataDir: ctx.userDataDir, managers: [Manager], settings: {},
    remove: async row => { removed.push(row.version);await Manager.uninstallRuntime({...ctx, version: row.version}); }});
  assert.deepEqual(removed, [B14]);
  assert.equal(Library.read(ctx.userDataDir, B14), null);assert.equal(Library.read(ctx.userDataDir, B15).ready, true);
});

function pack(entries) {
  const names = Object.keys(entries), contents = names.map(name => Buffer.from(entries[name]));
  const header = [Buffer.alloc(4)];header[0].writeUInt32LE(names.length);
  let offset = 0;
  for (const [index, name] of names.entries()) {
    const row = Buffer.alloc(4 + Buffer.byteLength(name) + 16);row.writeUInt32LE(Buffer.byteLength(name));row.write(name, 4);
    row.writeBigUInt64LE(BigInt(offset), row.length - 16);row.writeBigUInt64LE(BigInt(contents[index].length), row.length - 8);
    offset += contents[index].length;header.push(row);
  }
  const plain = zlib.zstdCompressSync(Buffer.concat([...header, ...contents])), data = Buffer.alloc(16);
  data.write('NRX1');data.writeUInt32LE(2, 4);data.writeBigUInt64LE(123n, 8);
  let state = 123n ^ 0x6e725f6e72785f31n;const M = (1n << 64n) - 1n;
  for (let at = 0; at < plain.length; at += 8) { state = (state + 0x9e3779b97f4a7c15n) & M;let v = ((state ^ (state >> 30n)) * 0xbf58476d1ce4e5b9n) & M;v = ((v ^ (v >> 27n)) * 0x94d049bb133111ebn) & M;v ^= v >> 31n;
    for (let i = 0; i < 8 && at + i < plain.length; i++) plain[at + i] ^= Number((v >> BigInt(i * 8)) & 255n); }
  return Buffer.concat([data, plain]);
}
test('ANR identifies a kit of another listed release from the kit itself and refuses an inconsistent one', t => {
  const {describeKit} = require('../src/modules/shared/reshade/generation/anr/prepare');
  const kit = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anr-kit-')), 'anr-fg-V.B14-kit-macos');
  t.after(() => fs.rmSync(path.dirname(kit), {recursive: true, force: true}));
  const write = (relative, data) => { fs.mkdirSync(path.dirname(path.join(kit, relative)), {recursive: true});fs.writeFileSync(path.join(kit, relative), data);return data; };
  const programs = Source.sizes.map(spec => write(`programs/metal-${spec.id}/pack.nrx`, pack({'program.json': JSON.stringify({version: 2, checkpoint_id: 'b14-checkpoint', width: spec.width, height: spec.height})})));
  const kernels = write('kernels-metal/pack.nrx', pack({'kernel.json': '{}'})), converter = write('bin/libmetalirconverter.dylib', 'converter');
  assert.equal(Library.kitVersion(kit), B14);
  assert.equal(Library.kitRoot(path.dirname(kit)), kit);
  const spec = describeKit(kit, B14);
  assert.equal(spec.checkpoint, 'b14-checkpoint');assert.equal(spec.declared, false);
  assert.equal(spec.kernelPack, sha(kernels));assert.equal(spec.converter, sha(converter));
  assert.deepEqual(spec.sizes.map(size => size.sha256), programs.map(sha));
  assert.equal(describeKit(kit, B15).checkpoint, Source.checkpoint, 'the declared release keeps its declared identities');
  write('programs/metal-2160p/pack.nrx', pack({'program.json': JSON.stringify({version: 2, checkpoint_id: 'other'})}));
  assert.throws(() => describeKit(kit, B14), /ANR kit FG-V\.B14 is incomplete or unsupported: its graph sizes do not share one checkpoint/);
  fs.writeFileSync(path.join(kit, 'programs/metal-2160p/pack.nrx'), programs[2]);
  assert.equal(describeKit(kit, B14).checkpoint, 'b14-checkpoint');
  fs.rmSync(path.join(kit, 'kernels-metal'), {recursive: true});
  assert.throws(() => describeKit(kit, B14), /incomplete or unsupported/);
});
