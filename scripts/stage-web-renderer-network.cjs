// Build the invisible Node-API network boundary included with the launcher.
// The payload holds the binary, its build record and the license; the source
// stays in the producer repository and is identified by its checksum.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Native = require('../src/modules/shared/runtime/local-native');
const { loadCommands } = require('./native-binary-tools.cjs');
const ID = 'web-renderer-network', VERSION = '1.0.1';
function stage({ output }) {
  if (process.platform !== 'darwin') throw new Error('Build the browser network helper on macOS.');
  const source = path.resolve(__dirname, '../src/modules/shared/web/native/renderer-network.c');
  const directory = path.join(path.resolve(output), ID, VERSION, 'universal');
  if (fs.existsSync(directory)) throw new Error('Choose an empty staging output; sealed helpers are never overwritten.');
  fs.mkdirSync(directory, { recursive: true });
  const flags = ['-bundle', '-undefined', 'dynamic_lookup', '-arch', 'arm64', '-arch', 'x86_64',
    '-mmacosx-version-min=11.0', '-O2', '-Wall', '-Wextra', '-lsandbox'];
  try {
    const binary = path.join(directory, 'renderer-network.node');
    execFileSync('/usr/bin/xcrun', ['clang', ...flags, source, '-o', binary], { stdio: 'pipe', timeout: 60000 });
    fs.chmodSync(binary, 0o755);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', binary], { stdio: 'pipe', timeout: 30000 });
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', binary], { stdio: 'pipe', timeout: 30000 });
    const architectures = Native.readMachOArchitectures(binary, { allowLibrary: true }).sort();
    if (JSON.stringify(architectures) !== JSON.stringify(['arm64', 'x86_64'])) throw new Error('Both Mac architectures are required.');
    const minimumMacOS = loadCommands(binary).minimumMacOS;
    if (minimumMacOS !== '11.0') throw new Error('Unexpected browser network helper deployment target.');
    fs.copyFileSync(path.resolve(__dirname, '../LICENSE'), path.join(directory, 'license.txt'));
    fs.chmodSync(path.join(directory, 'license.txt'), 0o644);
    const manifest = { schemaVersion: 1, id: ID, version: VERSION, sourceSha256: Native.hashFile(source),
      binarySha256: Native.hashFile(binary), minimumMacOS, architectures, nodeAPI: 1,
      scope: 'node-capable-game-renderer-network', build: {
        compiler: execFileSync('/usr/bin/xcrun', ['clang', '--version'], { encoding: 'utf8' }).split('\n')[0],
        flags, sources: ['renderer-network.c'], signing: 'ad-hoc' } };
    fs.writeFileSync(path.join(directory, 'helper.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    const files = fs.readdirSync(directory).sort().map(name => {
      const file = path.join(directory, name), stat = fs.statSync(file);
      return { path: name, size: stat.size, sha256: Native.hashFile(file), mode: stat.mode & 0o777,
        ...(name.endsWith('.node') ? { architectures } : {}) };
    });
    return { id: ID, version: VERSION, arch: 'universal', launcherArchitectures: ['arm64', 'x64'], minimumMacOS,
      sourceRelative: null, sourceSha256: manifest.sourceSha256,
      directoryRelative: `${ID}/${VERSION}/universal`, manifestRelative: 'helper.json',
      manifestSha256: Native.hashFile(path.join(directory, 'helper.json')), files,
      notices: [{ name: 'MacLauncher browser network helper', license: 'MIT', path: 'license.txt' }] };
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: node scripts/stage-web-renderer-network.cjs --output /path/to/staging');
  console.log(JSON.stringify(stage({ output: args[1] }), null, 2));
}
module.exports = { stage, ID, VERSION };
