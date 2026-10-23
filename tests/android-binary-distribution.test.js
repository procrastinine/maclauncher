const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const B = require('../src/modules/shared/runtime/bundled-native');
const Verifier = require('../src/modules/android/runtime-verifier');
const factories = {
  android: require('../src/modules/android/runtime-manager').createManager,
  'android-art': require('../src/modules/android/art/runtime-manager').createManager,
  'android-aim': require('../src/modules/android/providers/aim/manager').createManager
};

for (const [id, createManager] of Object.entries(factories)) {
  test(`${id} installs and verifies binary-only releases while retaining legacy source checks`, async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'android-binary-package-'));
    t.after(async () => { await Verifier.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const input = path.join(root, 'package'), prefix = id === 'android-aim' ? 'files/' : '';
    const manifestRelative = id === 'android-aim' ? 'manifest.json' : 'runtime.json';
    const executableRelative = id === 'android' ? 'native/libklepton-jvm.dylib' : id === 'android-art' ? 'art/host/linux-run' : 'bin/aimctl';
    const version = 'binary-package-1', arch = process.arch, repository = 'procrastinine/maclauncher-builds';
    const image = Buffer.alloc(32); image.writeUInt32LE(0xfeedfacf); image.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
    image.writeUInt32LE(id === 'android' ? 6 : 2, 12);
    const content = [[executableRelative, image, 0o755], ['LICENSE', Buffer.from('Synthetic license notice\n'), 0o644]];
    const files = content.map(([name, bytes, mode]) => {
      const file = path.join(input, prefix, name); fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes, { mode }); fs.chmodSync(file, mode);
      return { path: name, size: bytes.length, mode, sha256: B.digest(bytes), ...(name === executableRelative ? { architectures: [arch === 'arm64' ? 'arm64' : 'x86_64'] } : {}) };
    });
    const manifest = { schemaVersion: 1, version, minimumMacOS: '13.0', architectures: ['arm64'],
      profile: { id: 'binary-package', javaMajor: 21, nativeLoadTarget: 'maclauncher.android.bridge.GuestNativeLoader', artExecutionVersion: 1 }, files,
      ...(id === 'android-aim' ? { managerId: id, upstreamRevision: 'a'.repeat(40), platform: 'darwin', arch,
        executableRelative, dependencies: [], provenance: { sourceRevision: 'a'.repeat(40) },
        notices: [{ name: 'Fixture', license: 'Synthetic', sourceUrl: 'https://example.invalid/source', path: 'LICENSE' }] } : {}) };
    const metadata = Buffer.from(JSON.stringify(manifest)); fs.writeFileSync(path.join(input, manifestRelative), metadata, { mode: 0o644 });
    const archive = Buffer.from('Synthetic immutable archive'), tag = `${id}/v${version}/${arch}`, filename = `${id}-${version}-${arch}.tar.gz`;
    const record = { schemaVersion: 2, id, version, arch, launcherArchitectures: [arch], minimumMacOS: '13.0',
      manifestRelative, manifestSha256: B.digest(metadata), sourceSha256: 'b'.repeat(64), updatePolicy: 'manual', tag,
      asset: { filename, bytes: archive.length, sha256: B.digest(archive), url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${filename}` } };
    const declaration = { id, version, arch, launcherArchitectures: [arch], minimumMacOS: '13.0',
      directoryRelative: `${id}/${version}/${arch}`, manifestRelative, manifestSha256: record.manifestSha256,
      sourceRelative: null, sourceSha256: record.sourceSha256,
      files: [...files.map(file => ({ ...file, path: prefix + file.path })),
        { path: manifestRelative, size: metadata.length, mode: 0o644, sha256: record.manifestSha256 }] };
    let downloads = 0;
    const manager = createManager({ systemVersionSync: () => '27.0', fetchUrlBuffer: async () => ({ status: 200,
      body: Buffer.from(JSON.stringify({ schemaVersion: 2, projectId: id, updatePolicy: 'manual', packages: [record] })) }),
      downloadToFile: async (_url, destination) => { downloads++; fs.writeFileSync(destination, archive); },
      extractArchive: async (_archive, destination) => {
        fs.writeFileSync(path.join(destination, 'runtime-package.json'), JSON.stringify(declaration));
        fs.cpSync(input, path.join(destination, 'files'), { recursive: true });
      } });
    const selected = manager.inspectPackage(input, record);
    assert.equal(fs.existsSync(path.join(selected.payloadRoot, 'source.tar.gz')), false);
    assert.equal(B.verifyPayload(selected.root, selected.declaration), true);
    const legacy = { ...manifest, files: [...files, { path: 'source.tar.gz', size: 1, mode: 0o644, sha256: record.sourceSha256 }] };
    const legacyBytes = Buffer.from(JSON.stringify(legacy)); fs.writeFileSync(path.join(input, manifestRelative), legacyBytes);
    assert.throws(() => manager.inspectPackage(input, { ...record, manifestSha256: B.digest(legacyBytes) }), /ENOENT|source|missing|file/i);
    fs.writeFileSync(path.join(input, manifestRelative), metadata);
    if (arch !== 'arm64') return;
    const userDataDir = path.join(root, 'data'), nativeResourceRoot = path.join(root, 'absent-included');
    await manager.installRuntime({ userDataDir, nativeResourceRoot, version });
    assert.equal(downloads, 1);
    const installed = manager.resolveSelection(null, {}, userDataDir, { nativeResourceRoot, version });
    assert.equal(installed.ready, true);
    assert.equal(installed.version, version);
    assert.equal(fs.existsSync(path.join(installed.install.payloadRoot, 'source.tar.gz')), false);
    await Verifier.verifyPayload(installed.install.root, installed.install.declaration);
    fs.writeFileSync(installed.install.executablePath, Buffer.alloc(image.length, 1));
    await assert.rejects(Verifier.verifyPayload(installed.install.root, installed.install.declaration), /checksum|permissions/);
  });
}
