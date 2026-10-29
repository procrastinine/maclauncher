const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// A real signed Mach-O entry exercises the production native checks. The small
// sibling script supplies deterministic test-tool behavior after installation.
function nativeTool(directory, script) {
  fs.mkdirSync(directory, { recursive: true });
  const source = path.join(directory, 'tool.c'), binary = path.join(directory, 'tool');
  fs.writeFileSync(source, `#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  char script[PATH_MAX];
  if (strlen(argv[0]) + 16 >= sizeof(script)) return 125;
  strcpy(script, argv[0]);
  char *slash = strrchr(script, '/');
  if (!slash) return 125;
  strcpy(slash + 1, "fixture.cjs");
  char **args = calloc((size_t)argc + 2, sizeof(char *));
  if (!args) return 125;
  args[0] = ${JSON.stringify(process.execPath)};
  args[1] = script;
  for (int i = 1; i < argc; ++i) args[i + 1] = argv[i];
  execv(args[0], args);
  return 126;
}
`);
  execFileSync('clang', ['-arch', 'arm64', '-mmacosx-version-min=13.0', source, '-o', binary], { stdio: 'pipe' });
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', binary], { stdio: 'pipe' });
  return { binary: fs.readFileSync(binary), script: Buffer.from(script) };
}

function packageFor(directory, { id, version, manifest, entries, filesPrefix = '' }) {
  const repository = 'procrastinine/maclauncher-builds';
  const container = path.join(directory, 'archive-input'), payload = path.join(container, 'files');
  fs.mkdirSync(payload, { recursive: true });
  const files = entries.map(entry => {
    const file = path.join(payload, filesPrefix, entry.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entry.bytes, { mode: entry.mode }); fs.chmodSync(file, entry.mode);
    return { path: entry.path, size: entry.bytes.length, sha256: sha(entry.bytes), mode: entry.mode,
      ...(entry.architectures ? { architectures: entry.architectures } : {}) };
  });
  manifest = { schemaVersion: 1, version, arch: 'arm64', minimumMacOS: '13.0', ...manifest, files };
  const bytes = Buffer.from(JSON.stringify(manifest));
  fs.writeFileSync(path.join(payload, 'manifest.json'), bytes, { mode: 0o644 });
  const sourceSha256 = sha(Buffer.from('fixture source profile'));
  const wrapper = { id, version, arch: 'arm64', launcherArchitectures: ['arm64'], minimumMacOS: manifest.minimumMacOS,
    manifestRelative: 'manifest.json', manifestSha256: sha(bytes), sourceRelative: null, sourceSha256,
    files: [...files.map(file => ({ ...file, path: filesPrefix + file.path })),
      { path: 'manifest.json', size: bytes.length, mode: 0o644, sha256: sha(bytes) }] };
  fs.writeFileSync(path.join(container, 'runtime-package.json'), JSON.stringify(wrapper));
  const filename = `${id}-${version}-arm64.tar.gz`, archive = path.join(directory, filename);
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', container, 'runtime-package.json', 'files']);
  const archiveBytes = fs.readFileSync(archive), tag = `${id}/v${version}/arm64`;
  const record = { schemaVersion: 2, id, version, arch: 'arm64', launcherArchitectures: ['arm64'], minimumMacOS: manifest.minimumMacOS,
    manifestRelative: 'manifest.json', manifestSha256: sha(bytes), sourceSha256, updatePolicy: 'manual', tag,
    asset: { filename, bytes: archiveBytes.length, sha256: sha(archiveBytes),
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${filename}` } };
  return { archive, record, manifest, catalog: { schemaVersion: 2, projectId: id, updatePolicy: 'manual', packages: [record] } };
}
module.exports = { nativeTool, packageFor, sha };
