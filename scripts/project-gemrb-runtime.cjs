#!/usr/bin/env node
// Release-time resource projection: the input runtime and machine code stay intact.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const B = require('../src/modules/shared/runtime/bundled-native');
const MachO = require('../src/modules/shared/runtime/macho-load-commands');
const Content = require('../src/modules/shared/runtime/runtime-content');
const Payload = require('../src/modules/gemrb/runtime/payload-content');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const policyIdentity = () => sha(Buffer.concat([fs.readFileSync(__filename), fs.readFileSync(require.resolve('../src/modules/gemrb/runtime/payload-content'))]));
function projectGemRB({ input, output, version = '0.9.5-cli-v4-content1', dependencies = {} }) {
  input = fs.realpathSync(input); output = path.resolve(output);
  if (input === output || input.startsWith(output + path.sep) || output.startsWith(input + path.sep) || fs.existsSync(output)) throw new Error('Choose a separate, fresh GemRB output directory.');
  const stored = B.readRegular(path.join(input, 'manifest.json'), B.LIMITS.manifestBytes), original = JSON.parse(stored.bytes);
  B.validateManifest(original, { managerId: 'gemrb', version: '0.9.5-cli-v4', arch: 'arm64' });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version) || version === original.version) throw new Error('A new GemRB package version is required.');
  const source = path.join(input, 'files'); B.verifyPayload(source, original);
  const tool = dependencies.tool || ((file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 ** 2 }));
  const loadCommands = dependencies.loadCommands || MachO.readMachOLoadCommands;
  const appRelative = 'gemrb.app', executable = original.executableRelative;
  const instructions = file => sha(tool('/usr/bin/otool', ['-s', '__TEXT', '__text', file]).split('\n').slice(1).join('\n'));
  const code = instructions(path.join(source, executable)), closure = loadCommands(path.join(source, executable)).slices;
  tool('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(source, appRelative)]);
  B.realDirectory(path.dirname(output), { create: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(output), '.gemrb-content-'));
  try {
    const filesRoot = path.join(staging, 'files');
    fs.cpSync(source, filesRoot, { recursive: true, preserveTimestamps: true, mode: fs.constants.COPYFILE_FICLONE });
    const removed = Payload.omitOptionalTests(path.join(filesRoot, appRelative));
    if (removed.length !== Payload.OPTIONAL_TESTS.length) throw new Error('GemRB input does not contain the expected optional test resources.');
    for (const relative of B.fileInventory(filesRoot)) Content.assertRuntimePath(relative);
    tool('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', path.join(filesRoot, appRelative)]);
    tool('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(filesRoot, appRelative)]);
    if (instructions(path.join(filesRoot, executable)) !== code || !isDeepStrictEqual(loadCommands(path.join(filesRoot, executable)).slices, closure)) throw new Error('GemRB executable instructions or native dependency contract changed.');
    const before = new Map(original.files.map(record => [record.path, record])), changed = [];
    const files = B.fileInventory(filesRoot).map(relative => {
      const record = before.get(relative); if (!record) throw new Error('GemRB signing added an unexpected payload file.');
      const actual = B.readRegular(path.join(filesRoot, relative), B.LIMITS.fileBytes);
      if (actual.sha256 !== record.sha256) {
        if (![executable, 'gemrb.app/Contents/_CodeSignature/CodeResources'].includes(relative)) throw new Error('GemRB projection changed a non-signature resource.');
        changed.push(relative);
      }
      return { ...record, size: actual.size, sha256: actual.sha256, mode: actual.mode };
    });
    const manifest = { ...original, version, files, signature: { identity: '-', verified: true },
      provenance: { ...original.provenance, payloadProjection: { schema: 1, policySha256: policyIdentity(), inputVersion: original.version, inputManifestSha256: stored.sha256, removed, executableInstructionsSha256: code } }, createdAt: new Date().toISOString() };
    B.validateManifest(manifest); B.verifyPayload(filesRoot, manifest);
    B.verifyPayload(source, original);
    if (B.readRegular(path.join(input, 'manifest.json'), B.LIMITS.manifestBytes).sha256 !== stored.sha256) throw new Error('GemRB input manifest changed during projection.');
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
    fs.renameSync(staging, output);
    return { managerId: 'gemrb', version, arch: manifest.arch, output, inputManifestSha256: stored.sha256, manifestSha256: sha(fs.readFileSync(path.join(output, 'manifest.json'))), policySha256: policyIdentity(), removed, changed, files: files.length, executableInstructionsSha256: code, sourceUnchanged: true };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
module.exports = { projectGemRB, policyIdentity };
if (require.main === module) {
  if (process.argv.length < 4 || process.argv.length > 5) throw new Error('Usage: project-gemrb-runtime.cjs INPUT OUTPUT [NEW_VERSION]');
  console.log(JSON.stringify(projectGemRB({ input: process.argv[2], output: process.argv[3], version: process.argv[4] }), null, 2));
}
