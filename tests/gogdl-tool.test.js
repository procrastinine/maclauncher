const Harness = require('./helpers/future-upstream.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { ensureGogdl, macExecutable } = require('../src/core/gogdl-tool');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const REPOSITORY = 'Heroic-Games-Launcher/heroic-gogdl', NAME = 'gogdl_macos_arm64';

// Heroic's release list with one arm64 helper per release, its bytes matching
// GitHub's size and digest unless `served` replaces them.
function releases(entries, served = {}) {
  const list = entries.map(([tag, bytes]) => {
    const release = Harness.githubRelease(REPOSITORY, tag, [NAME]);
    release.assets = release.assets.map(asset => ({ ...asset, size: bytes.length, digest: 'sha256:' + digest(bytes) }));
    return release;
  });
  const routes = Harness.githubRoutes(REPOSITORY, list);
  entries.forEach(([tag, bytes], index) => { routes[list[index].assets[0].browser_download_url] = served[tag] || bytes; });
  return routes;
}
async function ensure(options, routes) {
  const start = Harness.network.requests.length;
  Harness.network.routes = routes;
  try { return { ...(await ensureGogdl(options)), downloads: Harness.network.requests.slice(start).filter(url => url.includes('/releases/download/')).length }; }
  finally { Harness.network.routes = null; }
}

test('GOG helper follows the newest release, verifies its published digest, reuses it and repairs corruption', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gogdl-tool-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { userDataDir: root, arch: 'arm64', platform: 'darwin' };
  let bytes = Buffer.from('helper artifact'), routes = releases([['v1.3.1', bytes]]);
  const first = await ensure(options, routes); assert.equal(first.downloads, 1); assert.equal(first.version, '1.3.1');
  assert.ok((await fs.stat(first.executablePath)).mode & 0o111);
  const again = await ensure(options, routes);
  assert.equal(again.executablePath, first.executablePath); assert.equal(again.downloads, 0);
  await fs.writeFile(first.executablePath, 'broken');
  assert.equal((await ensure(options, routes)).downloads, 1);
  assert.equal(await fs.readFile(first.executablePath, 'utf8'), bytes.toString());
  // A later release, then the same file replaced upstream with a new digest.
  const later = Buffer.from('helper artifact 1.4');
  const newer = await ensure(options, releases([['v1.4.0', later], ['v1.3.1', bytes]]));
  assert.equal(newer.version, '1.4.0'); assert.equal(newer.downloads, 1);
  bytes = Buffer.from('helper artifact 1.4 rebuilt');
  const replaced = await ensure(options, releases([['v1.4.0', bytes]]));
  assert.equal(replaced.downloads, 1);
  assert.equal(await fs.readFile(replaced.executablePath, 'utf8'), bytes.toString());
  // Without a release list, the newest installed helper keeps working.
  const offline = await ensure(options, {});
  assert.equal(offline.version, '1.4.0'); assert.equal(offline.downloads, 0);
});

test('GOG helper rejects changed artifacts without publishing partial setup', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gogdl-tool-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const routes = releases([['v1.0.0', Buffer.from('good')]], { 'v1.0.0': Buffer.from('bad!') });
  await assert.rejects(ensure({ userDataDir: root, arch: 'arm64', platform: 'darwin' }, routes), /checksum/);
  assert.deepEqual(await fs.readdir(path.join(root, 'external/tools')), []);
});

test('GOG helper selects the Mac executable for each CPU, including renamed or universal builds', () => {
  const assets = names => names.map(name => ({ name }));
  const current = assets(['gogdl_linux_x86_64', 'gogdl_windows_x86_64.exe', 'gogdl_macos_x86_64', 'gogdl_macos_arm64', 'gogdl_macos_arm64.sha256']);
  assert.equal(macExecutable(current, 'arm64').name, 'gogdl_macos_arm64');
  assert.equal(macExecutable(current, 'x64').name, 'gogdl_macos_x86_64');
  assert.equal(macExecutable(assets(['gogdl-darwin-universal']), 'x64').name, 'gogdl-darwin-universal');
  assert.equal(macExecutable(assets(['gogdl-linux-arm64', 'gogdl_macos_arm64-debug-symbols']), 'arm64'), null);
});
