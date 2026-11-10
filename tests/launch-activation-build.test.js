const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { build } = require('../scripts/build-launch-activation.cjs');
const source = path.join(__dirname, '../src/main/native/launch-activation.m');
const nodeHeaders = path.resolve(path.dirname(process.execPath), '../include/node/node_api.h');

test('the activation addon records a relative install name, not its build directory', {
  skip: process.platform !== 'darwin' || !fs.existsSync('/usr/bin/xcrun') || !fs.existsSync(nodeHeaders)
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-activation-'));
  try {
    fs.mkdirSync(path.join(root, 'src/main/native'), { recursive: true });
    fs.copyFileSync(source, path.join(root, 'src/main/native/launch-activation.m'));
    const output = build({ repoRoot: root });
    const id = execFileSync('/usr/bin/otool', ['-D', output], { encoding: 'utf8' }).trim().split('\n').at(-1);
    assert.equal(id, '@rpath/launch-activation.node');
    assert.ok(!fs.readFileSync(output).includes(Buffer.from(root)), 'The addon does not contain its build directory');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
