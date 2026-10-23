const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { ensureGogdl } = require('../src/core/gogdl-tool');

test('GOG historical-build helper verifies pinned artifact, reuses it and repairs corruption', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gogdl-tool-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('helper artifact'), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const catalog = { version: '1.0', source: 'https://example.invalid/source', revision: 'fixed', license: 'GPL-3.0', artifacts: { arm64: { url: 'https://example.invalid/helper', sha256, size: bytes.length } } };
  let fetched = 0;
  const options = { userDataDir: root, arch: 'arm64', platform: 'darwin', catalog, fetchBytes: async () => { fetched++; return { body: bytes }; } };
  const first = await ensureGogdl(options); assert.equal(fetched, 1);
  assert.ok((await fs.stat(first.executablePath)).mode & 0o111);
  assert.equal((await ensureGogdl(options)).executablePath, first.executablePath); assert.equal(fetched, 1);
  await fs.writeFile(first.executablePath, 'broken');
  await ensureGogdl(options); assert.equal(fetched, 2);
  assert.equal(await fs.readFile(first.executablePath, 'utf8'), bytes.toString());
});

test('GOG helper rejects changed artifacts without publishing partial setup', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gogdl-tool-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = { version: '1', artifacts: { arm64: { url: 'https://example.invalid/helper', sha256: '0'.repeat(64), size: 3 } } };
  await assert.rejects(ensureGogdl({ userDataDir: root, arch: 'arm64', platform: 'darwin', catalog, fetchBytes: async () => ({ body: Buffer.from('bad') }) }), /integrity/);
  assert.deepEqual(await fs.readdir(path.join(root, 'external/tools')), []);
});
