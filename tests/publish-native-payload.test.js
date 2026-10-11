const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const Payload = require('../scripts/native-payload.cjs');
const Publisher = require('../scripts/publish-native-payload.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'input.tar.gz'); fs.writeFileSync(archive, 'synthetic payload');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const sourceDownload = { url: 'https://github.com/owner/project/releases/download/native-sources/native-payload.tar.gz', sha256: 'c'.repeat(64) };
  const inventory = { launcherArch: 'arm64', maximumMacOS: '13.0', sourceDownload, sourceArtifacts: [] };
  const sourceMetadata = JSON.stringify({ sourceArtifacts: [] }, null, 2) + '\n';
  const sourceRelease = { draft: false, assets: [
    { name: 'native-payload.tar.gz', state: 'uploaded', digest: `sha256:${sourceDownload.sha256}`, browser_download_url: sourceDownload.url },
    { id: 42, name: 'native-payload.json', state: 'uploaded', size: Buffer.byteLength(sourceMetadata),
      digest: `sha256:${crypto.createHash('sha256').update(sourceMetadata).digest('hex')}` }
  ] };
  const tag = `native-payload-arm64-${sha256.slice(0, 16)}`, calls = [], variables = new Map();
  let release;
  const command = async args => {
    calls.push(args);
    if (args[0] === 'variable') {
      if (args[1] === 'list') return JSON.stringify([...variables].map(([name, value]) => ({ name, value })));
      if (args[1] === 'set') variables.set(args[2], args[args.indexOf('--body') + 1]);
      if (args[1] === 'delete') variables.delete(args[2]);
      return '';
    }
    if (args[0] === 'api') {
      if (args.includes('PATCH')) { release.draft = false; return '{}'; }
      const route = args[1];
      if (route.endsWith('/releases/tags/native-sources')) return JSON.stringify(sourceRelease);
      if (route.endsWith('/releases/assets/42')) return sourceMetadata;
      if (route.endsWith('/releases?per_page=100')) return JSON.stringify([release ? [release] : []]);
      if (route.endsWith('/releases/1')) return JSON.stringify(release);
      if (route.includes('/git/ref/heads/')) return JSON.stringify({ object: { type: 'commit', sha: 'a'.repeat(40) } });
      return JSON.stringify({ default_branch: 'main' });
    }
    if (args[0] === 'release' && args[1] === 'create') { release = { id: 1, tag_name: tag, draft: true, assets: [] }; return ''; }
    if (args[0] === 'release' && args[1] === 'upload') {
      const file = args.at(-1), bytes = fs.readFileSync(file), name = path.basename(file);
      release.assets.push({ name, state: 'uploaded', size: bytes.length, digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'),
        browser_download_url: `https://github.com/owner/project/releases/download/${tag}/${name}` });
      return '';
    }
    throw new Error('Unexpected command');
  };
  return { root, archive, sha256, inventory, sourceRelease, tag, calls, variables, command, release: () => release,
    options: { archive, repository: 'owner/project', repoRoot: root, command,
      verify: async () => ({ inventory, sha256, bytes: fs.statSync(archive).size }), log: () => {} } };
}

test('payload publication derives configuration and verifies all uploaded digests before setting variables', async t => {
  const f = fixture(t), result = await Publisher.publish(f.options);
  assert.equal(result.tag, f.tag); assert.equal(result.sha256, f.sha256);
  assert.equal(f.variables.size, 4); assert.equal(f.variables.get('MACLAUNCHER_NATIVE_PAYLOAD_ARCH'), 'arm64');
  assert.equal(f.variables.get('MACLAUNCHER_NATIVE_MAXIMUM_MACOS'), '13.0');
  assert.equal(f.variables.get('MACLAUNCHER_NATIVE_PAYLOAD_SHA256'), f.sha256);
  assert.equal(f.variables.get('MACLAUNCHER_NATIVE_PAYLOAD_URL'), result.url);
  const publish = f.calls.findIndex(args => args.includes('PATCH'));
  assert.ok(f.calls.findIndex(args => args[0] === 'variable' && args[1] === 'set') > publish);
  assert.ok(f.calls[publish].includes('prerelease=true')); assert.ok(f.calls[publish].includes('make_latest=false'));
  f.calls.length = 0; await Publisher.publish(f.options);
  assert.equal(f.calls.some(args => args[0] === 'release' || args.includes('PATCH') || args[1] === 'set'), false);
});
test('runtime-only publication checks source availability and exact pins using small metadata requests', async t => {
  const f = fixture(t);
  assert.deepEqual(await Publisher.verifyPublishedSources(f.inventory, f.command), f.inventory.sourceDownload);
  assert.equal(f.calls.length, 2);
  f.sourceRelease.assets[0].digest = `sha256:${'d'.repeat(64)}`;
  await assert.rejects(Publisher.publish(f.options), /source download is not published/);
  assert.equal(f.variables.size, 0); assert.equal(f.release(), undefined);
  f.sourceRelease.assets[0].digest = `sha256:${f.inventory.sourceDownload.sha256}`;
  await assert.rejects(Publisher.verifyPublishedSources({ ...f.inventory, sourceArtifacts: [{ version: 'changed' }] }, f.command), /source pins/);
  f.sourceRelease.assets[1].digest = `sha256:${'d'.repeat(64)}`;
  await assert.rejects(Publisher.verifyPublishedSources(f.inventory, f.command), /inventory checksum/);
});
test('local verification failure makes no GitHub calls', async t => {
  const f = fixture(t);
  await assert.rejects(Publisher.publish({ ...f.options, verify: async () => { throw new Error('Invalid archive'); } }), /Invalid archive/);
  assert.equal(f.calls.length, 0);
});
test('a complete payload publishes sources before creating the runtime-only input and configuring CI', async t => {
  const f = fixture(t), inventory = { ...f.inventory };
  delete inventory.sourceDownload;
  let options, verifications = 0;
  await assert.rejects(Publisher.publish({ ...f.options,
    verify: async archive => {
      if (++verifications === 1) return { inventory, sha256: f.sha256, bytes: fs.statSync(f.archive).size, resourceRoot: 'verified-runtimes' };
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(fs.readFileSync(archive, 'utf8'), 'runtime-only bytes', 'Keep the derived archive until nested publication completes');
      throw new Error('Synthetic runtime publication boundary');
    },
    exportRuntime: async value => { options = value; fs.writeFileSync(value.output, 'runtime-only bytes'); }
  }), /Synthetic runtime publication boundary/);
  assert.equal(f.release().draft, false);
  assert.equal(options.resourceRoot, 'verified-runtimes');
  assert.deepEqual(options.sourceDownload, {
    url: `https://github.com/owner/project/releases/download/${f.tag}/native-payload.tar.gz`, sha256: f.sha256
  });
  assert.equal(f.variables.size, 0, 'The source-inclusive archive must never become the app-build download');
  assert.equal(fs.existsSync(options.output), false, 'Remove temporary archives after publication ends');
});
test('a wrong remote digest leaves the draft unpublished and configuration untouched', async t => {
  const f = fixture(t);
  const command = async args => { const value = await f.command(args); if (args[0] === 'release' && args[1] === 'upload') f.release().assets.at(-1).digest = 'sha256:' + '0'.repeat(64); return value; };
  await assert.rejects(Publisher.publish({ ...f.options, command }), /checksum or size/);
  assert.equal(f.release().draft, true); assert.equal(f.variables.size, 0);
});
test('partial uploads can resume without replacing already verified assets', async t => {
  const f = fixture(t); let uploads = 0;
  await assert.rejects(Publisher.publish({ ...f.options, command: async args => {
    if (args[0] === 'release' && args[1] === 'upload' && ++uploads === 2) throw new Error('Interrupted upload');
    return f.command(args);
  } }), /Interrupted upload/);
  assert.equal(f.variables.size, 0); assert.equal(f.release().assets.length, 1);
  f.calls.length = 0; await Publisher.publish(f.options);
  assert.equal(f.calls.filter(args => args[0] === 'release' && args[1] === 'upload').length, 2);
});
test('failed variable updates restore previous values, including writes whose response was lost', async t => {
  const f = fixture(t); f.variables.set('FIRST', 'previous'); let failed = false;
  const command = async args => { const value = await f.command(args); if (args[0] === 'variable' && args[1] === 'set' && args[2] === 'SECOND' && !failed) { failed = true; throw new Error('Lost response'); } return value; };
  await assert.rejects(Publisher.configureVariables('owner/project', { FIRST: 'new', SECOND: 'new' }, command), /Lost response/);
  assert.deepEqual([...f.variables], [['FIRST', 'previous']]);
});
test('inventory reading bounds the first tar member and rejects unrelated or truncated archives', async t => {
  const f = fixture(t), metadata = Buffer.from(JSON.stringify(f.inventory));
  fs.writeFileSync(f.archive, zlib.gzipSync(Buffer.concat([Payload.tarHeader('native-payload.json', metadata.length, 0o644), metadata])));
  assert.deepEqual(await Publisher.readInventory(f.archive), f.inventory);
  fs.writeFileSync(f.archive, zlib.gzipSync(Payload.tarHeader('other.json', 1, 0o644)));
  await assert.rejects(Publisher.readInventory(f.archive), /bounded native payload inventory/);
  fs.writeFileSync(f.archive, zlib.gzipSync(Payload.tarHeader('native-payload.json', Payload.LIMITS.metadataBytes + 1, 0o644)));
  await assert.rejects(Publisher.readInventory(f.archive), /bounded native payload inventory/);
  fs.writeFileSync(f.archive, zlib.gzipSync(Payload.tarHeader('native-payload.json', 50, 0o644)));
  await assert.rejects(Publisher.readInventory(f.archive), /truncated/);
});
