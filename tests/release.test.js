const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { parseVersion, compareVersions, planRelease, getPlan, assetNames, verifyAssets, githubRequest, findRelease, publish } = require('../scripts/release.cjs');
const sha = 'a'.repeat(40);
const push = { eventName: 'push', ref: 'refs/heads/main', event: { repository: { default_branch: 'main' } }, version: '0.3.0', previousVersion: '0.2.1' };

test('GitHub lookups use authenticated gh GET requests and only treat HTTP 404 as absence', async () => {
  const env = { GITHUB_REPOSITORY: 'example/launcher', GH_TOKEN: 'test-token' }, calls = [];
  const tool = (command, args, options) => {
    calls.push(args);
    assert.equal(command, 'gh'); assert.equal(options.env, env);
    assert.deepEqual(args.slice(0, 4), ['api', '--method', 'GET', 'repos/example/launcher/releases/tags/v0.3.0']);
    assert.equal(args.some(value => value.includes(env.GH_TOKEN)), false);
    return '{"id":123,"draft":true}';
  };
  for (let count = 0; count < 2; count++) assert.deepEqual(await githubRequest('releases/tags/v0.3.0', { env, tool }), { id: 123, draft: true });
  assert.equal(calls.length, 2);
  const failing = status => () => { throw Object.assign(new Error('Command failed'), { stderr: Buffer.from(`gh: Request failed (HTTP ${status})\n`) }); };
  assert.equal(await githubRequest('missing', { env, tool: failing(404) }), null);
  for (const status of [401, 403, 429, 500, 503]) await assert.rejects(githubRequest('releases', { env, tool: failing(status), pause: async () => {} }), new RegExp(`HTTP ${status}`));
  await assert.rejects(githubRequest('releases', { env, tool: () => { throw new Error('Connection reset'); }, pause: async () => {} }), /Retry publication/);
  await assert.rejects(githubRequest('releases', { env, tool: () => 'not JSON' }), /invalid JSON/);
});
test('transient GitHub lookups retry with bounded delays while authentication failures stop immediately', async () => {
  let attempts = 0; const delays = [];
  const env = { GITHUB_REPOSITORY: 'example/launcher' }, pause = async ms => { delays.push(ms); };
  const tool = () => { if (++attempts < 3) throw new Error('Connection reset'); return '{"id":123}'; };
  assert.deepEqual(await githubRequest('releases/123', { env, tool, pause }), { id: 123 });
  assert.equal(attempts, 3); assert.deepEqual(delays, [1000, 2000]);
  attempts = 0; delays.length = 0;
  await assert.rejects(githubRequest('releases', { env, pause, tool: () => {
    attempts++; throw Object.assign(new Error('Authentication failed'), { stderr: 'gh: Bad credentials (HTTP 401)\n' });
  } }), /HTTP 401/);
  assert.equal(attempts, 1); assert.deepEqual(delays, []);
  attempts = 0;
  await assert.rejects(githubRequest('releases', { env, pause, tool: () => { attempts++; throw new Error('Connection reset'); } }), /after three attempts/);
  assert.equal(attempts, 3);
});
test('failed GitHub lookups retain transport diagnostics without exposing tokens or home paths', async () => {
  const env = { GITHUB_REPOSITORY: 'example/launcher', GH_TOKEN: 'test-private-token' };
  await assert.rejects(githubRequest('releases/123', { env, pause: async () => {}, tool: () => {
    throw Object.assign(new Error('Command failed'), { status: 1, code: 'ETIMEDOUT',
      stderr: `TLS handshake timeout; ${env.GH_TOKEN}; /Users/example/cache/config` });
  } }), error => {
    assert.match(error.message, /TLS handshake timeout/);
    assert.match(error.message, /attempt 3\/3, code ETIMEDOUT, exit 1/);
    assert.match(error.message, /GET releases\/123/);
    assert.doesNotMatch(error.message, /test-private-token|\/Users\/example/);
    return true;
  });
});

test('releases follow actual version increments on the default branch, with manual builds kept unpublished', () => {
  assert.deepEqual(planRelease(push), { build: true, publish: true, version: '0.3.0', tag: 'v0.3.0', prerelease: false });
  for (const extra of [{ previousVersion: '0.3.0' }, { ref: 'refs/heads/feature' }, { eventName: 'pull_request' }, { event: { ...push.event, deleted: true } }]) assert.equal(planRelease({ ...push, ...extra }).build, false);
  assert.equal(planRelease({ ...push, eventName: 'workflow_dispatch' }).build, true);
  assert.equal(planRelease({ ...push, eventName: 'workflow_dispatch' }).publish, false);
  assert.equal(planRelease({ ...push, previousVersion: null }).publish, true);
  assert.equal(planRelease({ ...push, version: '0.3.0-beta.2' }).prerelease, true);
  for (const version of ['0.2.0', '0.2.1+build.1']) assert.throws(() => planRelease({ ...push, version }), /must increase/);
  assert.equal(planRelease({ ...push, ref: 'refs/tags/v0.3.0' }).publish, true);
  assert.throws(() => planRelease({ ...push, ref: 'refs/tags/v0.2.1' }), /tag must match/);
});
test('semantic version ordering handles prereleases numerically and rejects unsafe or malformed versions', () => {
  const ordered = ['0.2.9', '0.3.0-alpha', '0.3.0-alpha.1', '0.3.0-alpha.2', '0.3.0-alpha.10', '0.3.0-beta', '0.3.0-rc.1', '0.3.0', '0.4.0', '1.0.0'];
  for (let i = 1; i < ordered.length; i++) {
    assert.equal(compareVersions(ordered[i], ordered[i - 1]), 1);
    assert.equal(compareVersions(ordered[i - 1], ordered[i]), -1);
  }
  assert.equal(compareVersions('1.0.0+one', '1.0.0+two'), 0);
  for (const version of ['01.2.3', '1.2', '1.2.3-01', '1.2.3\n', 'v1.2.3', '1.2.3;echo test', '', null]) assert.throws(() => parseVersion(version), /valid semantic version/);
});
test('push comparison uses the complete before commit, including multi-commit pushes', t => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-')); t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init']); git(['config', 'user.name', 'Test Author']); git(['config', 'user.email', 'test@example.invalid']);
  const commit = version => { fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ version })); git(['add', 'package.json']); git(['commit', '-m', `Version ${version}`]); return git(['rev-parse', 'HEAD']); };
  const before = commit('0.2.1'), eventFile = path.join(repoRoot, 'event.json');
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_PATH: eventFile };
  const event = { ...push.event, before };
  fs.writeFileSync(eventFile, JSON.stringify(event));
  assert.equal(getPlan({ env, repoRoot }).build, false);
  fs.writeFileSync(eventFile, JSON.stringify({ ...event, before: sha }));
  assert.equal(getPlan({ env, repoRoot }).publish, true, 'A clean root can start publication without retained historical commits');
  commit('0.3.0'); git(['commit', '--allow-empty', '-m', 'Documentation']);
  fs.writeFileSync(eventFile, JSON.stringify(event));
  assert.equal(getPlan({ env, repoRoot }).tag, 'v0.3.0');
  fs.writeFileSync(eventFile, JSON.stringify({ ...event, before: sha }));
  assert.throws(() => getPlan({ env, repoRoot }), /push baseline/);
});
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-assets-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifest = { version: '0.3.0', releaseTag: 'v0.3.0', sourceCommit: sha, arch: 'arm64', maximumNativeMacOS: '13.0' };
  const names = assetNames(manifest);
  for (const name of names) fs.writeFileSync(path.join(directory, name), `Synthetic release asset: ${name}`);
  fs.writeFileSync(path.join(directory, 'build-manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), names.slice(0, 2).map(name => `${createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')}  ${name}\n`).join(''));
  const env = { RELEASE_VERSION: '0.3.0', GITHUB_SHA: sha, GITHUB_REPOSITORY: 'owner/project', GH_TOKEN: 'synthetic-token' };
  const assets = () => names.slice(0, 1).map(name => { const bytes = fs.readFileSync(path.join(directory, name));
    return { name, state: 'uploaded', size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }; });
  return { directory, env, manifest, names, assets };
}
test('release publication verifies downloaded archives and the exact source identity before any network write', async t => {
  const f = fixture(t);
  assert.deepEqual(await verifyAssets(f.directory, { version: '0.3.0', sha }), f.names);
  await assert.rejects(verifyAssets(f.directory, { version: '0.3.0', sha: 'b'.repeat(40) }), /exact source commit/);
  fs.appendFileSync(path.join(f.directory, f.names[0]), 'corrupted');
  let writes = 0;
  await assert.rejects(publish({ ...f, request: async () => null, tool: () => writes++ }), /checksum mismatch/);
  assert.equal(writes, 0);
});
test('unexpected files, links and incomplete checksum sets stop release publication', async t => {
  const f = fixture(t), extra = path.join(f.directory, 'unexpected.txt');
  fs.writeFileSync(extra, 'Unlisted file');
  await assert.rejects(verifyAssets(f.directory, { version: '0.3.0', sha }), /unexpected files/);
  fs.unlinkSync(extra);
  fs.unlinkSync(path.join(f.directory, 'LICENSE')); fs.symlinkSync('ATTRIBUTIONS.md', path.join(f.directory, 'LICENSE'));
  await assert.rejects(verifyAssets(f.directory, { version: '0.3.0', sha }), /regular files/);
  fs.unlinkSync(path.join(f.directory, 'LICENSE')); fs.writeFileSync(path.join(f.directory, 'LICENSE'), 'License');
  fs.writeFileSync(path.join(f.directory, 'SHA256SUMS.txt'), fs.readFileSync(path.join(f.directory, 'SHA256SUMS.txt'), 'utf8').split('\n').slice(0, 1).join('\n'));
  await assert.rejects(verifyAssets(f.directory, { version: '0.3.0', sha }), /checksums are missing/);
});
test('release creation targets the built commit and only publishes after all uploads succeed', async t => {
  const f = fixture(t), commands = [];
  const request = async route => route.startsWith('releases?') ? [] : route.startsWith('releases/') && commands.length ? { id: 123, draft: true, assets: f.assets() } : null;
  await publish({ ...f, request, tool: (command, args) => commands.push([command, ...args]) });
  assert.equal(commands.length, 3);
  assert.deepEqual(commands[0].slice(0, 4), ['gh', 'release', 'create', 'v0.3.0']);
  assert.equal(commands[0][commands[0].indexOf('--target') + 1], sha);
  assert.ok(commands[0].includes('--draft'));
  assert.equal(commands[1].filter(arg => arg.startsWith(f.directory + path.sep)).length, 1);
  assert.ok(commands[2].includes('draft=false')); assert.ok(commands[2].includes('prerelease=false')); assert.ok(commands[2].includes('make_latest=legacy'));
  const failed = [];
  await assert.rejects(publish({ ...f, request: async route => route.startsWith('releases?') ? [] : null, tool: (_, args) => { failed.push(args); if (args[1] === 'upload') throw new Error('Upload interrupted'); } }), /Upload interrupted/);
  assert.equal(failed.some(args => args[0] === 'api'), false);
});
test('retries resume matching drafts, preserve published releases and reject conflicting tags', async t => {
  const f = fixture(t), commands = [], reference = { object: { type: 'commit', sha } };
  let release = { id: 123, draft: true, target_commitish: sha, assets: f.assets() };
  const request = async route => route.startsWith('releases/') ? release : reference;
  const tool = (_, args) => commands.push(args);
  await publish({ ...f, request, tool }); assert.equal(commands.length, 1); assert.equal(commands[0][0], 'api');
  commands.length = 0;
  release = { draft: false, assets: f.assets() };
  assert.equal((await publish({ ...f, request, tool })).unchanged, true); assert.equal(commands.length, 0);
  reference.object.sha = 'b'.repeat(40);
  await assert.rejects(publish({ ...f, request, tool }), /another commit/); assert.equal(commands.length, 0);
  reference.object.sha = sha; release = { draft: true, assets: [{ name: 'unexpected.txt' }] };
  await assert.rejects(publish({ ...f, request, tool }), /unexpected assets/);
});
test('draft retries upload only absent or mismatched assets and verify remote checksums before publication', async t => {
  const f = fixture(t), commands = [], release = { id: 123, draft: true, target_commitish: sha, assets: f.assets() };
  release.assets = [];
  const request = async route => route.startsWith('releases/') ? release : { object: { type: 'commit', sha } };
  const tool = (_, args) => { commands.push(args); if (args[1] === 'upload') release.assets = f.assets(); };
  await publish({ ...f, request, tool });
  assert.deepEqual(commands[0].filter(arg => arg.startsWith(f.directory + path.sep)), [path.join(f.directory, 'MacLauncher.app.zip')]);
  assert.ok(commands[1].includes('draft=false'));
  commands.length = 0; release.assets[0].digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(publish({ ...f, request, tool: (_, args) => commands.push(args) }), /matching checksums/);
  assert.equal(commands.some(args => args[0] === 'api'), false);
});
test('GitHub lookup failures never become permission to create a release', async t => {
  const f = fixture(t); let writes = 0;
  await assert.rejects(publish({ ...f, request: async () => { throw new Error('HTTP 403'); }, tool: () => writes++ }), /403/);
  assert.equal(writes, 0);
});
test('authenticated release listings locate drafts omitted by the published tag endpoint', async () => {
  const draft = { id: 123, tag_name: 'v0.3.0', draft: true };
  const calls = [];
  assert.equal(await findRelease('v0.3.0', async route => { calls.push(route); return route.startsWith('releases?') ? [draft] : null; }), draft);
  assert.equal(calls.length, 2);
  await assert.rejects(findRelease('v0.3.0', async () => null), /listing is unavailable/);
});
test('prereleases stay outside Latest and incomplete remote uploads stay unpublished', async t => {
  const f = fixture(t), version = '0.3.0-beta.1', commands = [];
  f.env.RELEASE_VERSION = version; f.manifest.version = version; f.manifest.releaseTag = `v${version}`;
  fs.writeFileSync(path.join(f.directory, 'build-manifest.json'), JSON.stringify(f.manifest));
  const draft = { id: 123, draft: true, target_commitish: sha, assets: f.assets() };
  const request = async route => route.startsWith('releases/') ? draft : null;
  await publish({ ...f, request, tool: (_, args) => commands.push(args) });
  assert.ok(commands.at(-1).includes('prerelease=true')); assert.ok(commands.at(-1).includes('make_latest=false'));
  commands.length = 0; draft.assets[0].state = 'new';
  await assert.rejects(publish({ ...f, request, tool: (_, args) => commands.push(args) }), /complete release asset set/);
  assert.equal(commands.some(args => args[0] === 'api'), false);
});
