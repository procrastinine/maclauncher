const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Source = require('../src/modules/android/runtime-source');

test('Android source members use the supplied source owner and retain module identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-source-'));
  try {
    const directory = path.join(root, 'src/modules/android/art');
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, 'components.json');
    fs.writeFileSync(target, JSON.stringify({ linuxRun: 'host/linux-run' }));
    const options = { sourceRoot: root };
    assert.equal(Source.file('art/components.json', options), target);
    assert.equal(Source.moduleUrl('art/components.json', options), pathToFileURL(target).href);
    assert.deepEqual(Source.json('art/components.json', options), { linuxRun: 'host/linux-run' });
    for (const name of ['../other.json', '/absolute.json', 'art/../components.json', 'art\\components.json', 'art//components.json'])
      assert.throws(() => Source.file(name, options), /Invalid Android source member/);
    assert.throws(() => Source.file('art', options), /unavailable/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
