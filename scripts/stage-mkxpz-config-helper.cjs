// Developer staging only. Play reads the reviewed supplemental directly.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Native = require('../src/modules/shared/runtime/local-native');
const { loadCommands } = require('./stage-native-runtimes.cjs');

const VERSION = 'config-identity-v7-universal';
const ID = 'mkxpz-config-helper';
function stage({ output }) {
  if (process.platform !== 'darwin') throw new Error('Build the shared config helper on macOS with Apple Command Line Tools.');
  const source = path.resolve(__dirname, '../src/modules/rgss/overlays/mkxpz-config.c');
  const identitySource = path.resolve(__dirname, '../src/modules/rgss/overlays/mkxpz-identity.m');
  const directory = path.join(path.resolve(output), ID, VERSION, 'universal');
  if (fs.existsSync(directory)) throw new Error('Choose an empty staging output; reviewed helpers are never overwritten.');
  fs.mkdirSync(directory, { recursive: true });
  const installName = '@rpath/mkxpz-config.dylib';
  const flags = ['-dynamiclib', '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=11.0', '-O2', '-Wall', '-Wextra', '-install_name', installName];
  try {
    const library = path.join(directory, 'mkxpz-config.dylib');
    const identityFlags = ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'AppKit', '-framework', 'ImageIO'];
    execFileSync('/usr/bin/xcrun', ['clang', ...flags, ...identityFlags, source, identitySource, '-o', library], { stdio: 'pipe', timeout: 60000 });
    fs.chmodSync(library, 0o755);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', library], { stdio: 'pipe', timeout: 30000 });
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', library], { stdio: 'pipe', timeout: 30000 });
    const architectures = Native.readMachOArchitectures(library, { allowLibrary: true }).sort();
    if (JSON.stringify(architectures) !== JSON.stringify(['arm64', 'x86_64'])) throw new Error('The config helper must contain both supported Mac CPU slices.');
    const minimumMacOS = loadCommands(library).minimumMacOS;
    if (minimumMacOS !== '11.0') throw new Error('The config helper has an unexpected macOS deployment target.');
    const identifiers = execFileSync('/usr/bin/otool', ['-D', library], { encoding: 'utf8', timeout: 10000 }).split('\n').map(line => line.trim()).filter(line => line && !line.endsWith(':'));
    if (identifiers.length !== 2 || identifiers.some(value => value !== installName)) throw new Error('The config helper contains an unexpected or private dynamic-library identity.');
    fs.copyFileSync(source, path.join(directory, 'mkxpz-config.c'));
    fs.copyFileSync(identitySource, path.join(directory, 'mkxpz-identity.m'));
    fs.copyFileSync(path.resolve(__dirname, '../LICENSE'), path.join(directory, 'license.txt'));
    for (const name of ['mkxpz-config.c', 'mkxpz-identity.m', 'license.txt']) fs.chmodSync(path.join(directory, name), 0o644);
    const compiler = execFileSync('/usr/bin/xcrun', ['clang', '--version'], { encoding: 'utf8', timeout: 10000 }).split('\n')[0];
    const manifest = { schemaVersion: 1, id: ID, version: VERSION, sourceSha256: Native.hashFile(source),
      binarySha256: Native.hashFile(library), licenseSha256: Native.hashFile(path.join(directory, 'license.txt')),
      minimumMacOS, architectures, scope: 'selected-executable-config-and-display-identity',
      build: { compiler, flags: [...flags, ...identityFlags], sources: ['mkxpz-config.c', 'mkxpz-identity.m'], installName, signing: 'ad-hoc' } };
    fs.writeFileSync(path.join(directory, 'helper.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    const files = fs.readdirSync(directory).sort().map(name => {
      const file = path.join(directory, name), stat = fs.statSync(file);
      return { path: name, size: stat.size, sha256: Native.hashFile(file), mode: stat.mode & 0o777,
        ...(name.endsWith('.dylib') ? { architectures } : {}) };
    });
    return { id: ID, version: VERSION, arch: 'universal', launcherArchitectures: ['arm64', 'x64'], minimumMacOS,
      sourceRelative: 'mkxpz-config.c', sourceSha256: manifest.sourceSha256,
      directoryRelative: `${ID}/${VERSION}/universal`, manifestRelative: 'helper.json',
      manifestSha256: Native.hashFile(path.join(directory, 'helper.json')), files,
      notices: [{ name: 'MacLauncher MKXP-Z config isolation helper', license: 'MIT', path: 'license.txt' }] };
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: node scripts/stage-mkxpz-config-helper.cjs --output /path/to/empty-staging');
  console.log(JSON.stringify(stage({ output: args[1] }), null, 2));
}
module.exports = { stage, ID, VERSION };
