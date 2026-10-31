const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { promisify } = require('node:util');
const { finished } = require('node:stream/promises');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'asar-dependency-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const files = new Map([
    ['package.json', Buffer.from(JSON.stringify({ name: 'archive-fixture', version: '1.0.0', main: 'src/main.js' }))],
    ['src/main.js', Buffer.from('module.exports = "archive contents stay intact";\n')],
    ['assets with spaces/日本語.json', Buffer.from('{"fixture":"preserved"}\n')],
    ['resources/native.node', Buffer.from([0, 1, 127, 128, 255])],
    ['.runtime-profile.json', Buffer.from('{"hidden":true}\n')],
    ['private/secret.json', Buffer.from('{"excluded":true}\n')]
  ]);
  for (const [name, bytes] of files) {
    const file = path.join(source, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  return { root, source, files };
}

function assertArchive(asar, archive, expected) {
  const listing = asar.listPackage(archive).map(name => name.replaceAll('\\', '/'));
  assert.ok(listing.length > 0, 'A nonempty input must not silently produce an empty ASAR');
  for (const [name, bytes] of expected) {
    assert.ok(listing.includes('/' + name), `Archive omitted ${name}`);
    assert.equal(asar.statFile(archive, name).size, bytes.length, name);
    assert.deepEqual(asar.extractFile(archive, name), bytes, name);
  }
}

test('the installed ASAR directory API preserves nonempty nested files and their exact bytes', async t => {
  const f = fixture(t), asar = require('@electron/asar');
  const archive = path.join(f.root, 'direct.asar');
  await finished(await asar.createPackage(f.source, archive));
  assertArchive(asar, archive, f.files);

  const unpacked = path.join(f.root, 'unpacked.asar');
  await finished(await asar.createPackageWithOptions(f.source, unpacked, { unpack: '*.node' }));
  assertArchive(asar, unpacked, f.files);
  assert.equal(asar.statFile(unpacked, 'resources/native.node').unpacked, true);
  assert.deepEqual(fs.readFileSync(path.join(unpacked + '.unpacked', 'resources/native.node')),
    f.files.get('resources/native.node'));
});

test('ASAR and its glob dependency retain legacy matching, recursive, brace, dot and ignore semantics', async t => {
  const f = fixture(t), asarRequire = createRequire(require.resolve('@electron/asar'));
  const globRequire = createRequire(asarRequire.resolve('glob'));
  const minimatch = asarRequire('minimatch');
  assert.equal(typeof minimatch, 'function', 'ASAR unpack patterns use the callable minimatch API');
  assert.equal(minimatch('src/main.js', '**/*.js'), true);
  assert.equal(minimatch('src/main.js', '**/*.json'), false);
  assert.equal(typeof globRequire('minimatch').Minimatch, 'function', 'Glob requires the matching constructor');
  const glob = asarRequire('glob');
  const files = await promisify(glob.glob)('**/*.{js,json}', {
    cwd: f.source, dot: true, nodir: true, ignore: ['private/**']
  });
  assert.deepEqual(files.sort(), ['.runtime-profile.json', 'assets with spaces/日本語.json', 'package.json', 'src/main.js']);
});

test('the installed Builder ASAR pipeline preserves filtering, transformed bytes and native unpacking', async t => {
  const f = fixture(t);
  const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
  const { AsarPackager } = require('app-builder-lib/out/asar/asarUtil');
  const { checkFileInArchive } = require('app-builder-lib/out/asar/asarFileChecker');
  const builderRequire = createRequire(require.resolve('app-builder-lib/out/asar/asarUtil'));
  const asar = builderRequire('@electron/asar');
  const resources = path.join(f.root, 'resources'), destination = path.join(resources, 'app');
  fs.mkdirSync(resources);
  const matcher = new FileMatcher(f.source, destination, value => value, ['**/*', '!private/**']);
  const files = await require('builder-util').walk(f.source, matcher.createFilter());
  const transformed = Buffer.from('module.exports = "transformed fixture bytes";\n');
  const mainIndex = files.indexOf(path.join(f.source, 'src/main.js'));
  assert.ok(mainIndex >= 0, 'Builder traversal must select the application main entry');
  const unpack = new FileMatcher(f.source, destination, value => value, ['**/*.node']).createFilter();
  const packager = new AsarPackager({ info: { getWorkspaceRoot: async () => f.root } }, {
    resourcePath: resources, defaultDestination: destination, options: { smartUnpack: false }, unpackPattern: unpack
  });
  await packager.pack([{ src: f.source, destination, files,
    metadata: new Map(files.map(file => [file, fs.lstatSync(file)])),
    transformedFiles: new Map([[mainIndex, transformed]]) }]);
  const archive = path.join(resources, 'app.asar');
  const expected = new Map([...f.files].filter(([name]) => !name.startsWith('private/')));
  expected.set('src/main.js', transformed);
  assertArchive(asar, archive, expected);
  assert.equal(asar.listPackage(archive).some(name => name.includes('private')), false);
  assert.equal((await checkFileInArchive(archive, 'src/main.js', 'Fixture main entry')).size, transformed.length);
  assert.equal(asar.statFile(archive, 'resources/native.node').unpacked, true);
  assert.deepEqual(fs.readFileSync(path.join(archive + '.unpacked', 'resources/native.node')),
    f.files.get('resources/native.node'));
});
