const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function build({ repoRoot = path.resolve(__dirname, '..'), arch = process.arch } = {}) {
  const output = path.join(repoRoot, 'src/resources/launch-activation.node');
  const headers = path.resolve(path.dirname(process.execPath), '../include/node');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync('/usr/bin/xcrun', ['clang', '-dynamiclib', '-undefined', 'dynamic_lookup', '-fobjc-arc',
    '-arch', arch === 'x64' ? 'x86_64' : arch, '-mmacosx-version-min=13.0', '-DNAPI_VERSION=8',
    '-I', headers, '-framework', 'AppKit', '-framework', 'CoreGraphics',
    path.join(repoRoot, 'src/main/native/launch-activation.m'), '-o', output], { stdio: 'inherit' });
  return output;
}
module.exports = { build };
if (require.main === module) build({ arch: process.argv[2] || process.arch });
