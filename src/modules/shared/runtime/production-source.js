// Projection of disposable source exports only. Never edits a checkout or a
// published runtime. Production source, build metadata and notices stay intact.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const Content = require('./runtime-content');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function prune(root) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Production source requires a real export directory.');
  const removed = [], manifests = [];
  function walk(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name, file = path.join(directory, entry.name);
      if (Content.excludedReason(name)) {
        removed.push(name); fs.rmSync(file, { recursive: entry.isDirectory(), force: true }); continue;
      }
      if (entry.isDirectory()) walk(file, name);
      else if (entry.isFile() && entry.name === 'Cargo.toml') {
        const before = fs.readFileSync(file, 'utf8'), lines = before.split(/(?<=\n)/), kept = [];
        let omit = false;
        for (const line of lines) {
          if (/^\s*\[/.test(line)) omit = /^\s*\[\[(?:test|bench|example)\]\]/.test(line);
          if (!omit) kept.push(line);
        }
        const after = kept.join('');
        if (after !== before) {
          fs.writeFileSync(file, after);
          fs.utimesSync(file, 0, 0);
          manifests.push({ path: name, operation: 'omit explicit test/benchmark/example targets',
            beforeSha256: digest(before), afterSha256: digest(after) });
        }
      }
      if (entry.isFile()) fs.utimesSync(file, 0, 0);
    }
    fs.utimesSync(directory, 0, 0);
  }
  walk(root);
  return { schema: 1, buildTesting: false, removed: removed.sort(), manifests };
}

function projectArchive(source, destination) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maclauncher-production-source-'));
  try {
    const entries = execFileSync('/usr/bin/tar', ['-tzf', source], { encoding: 'utf8', maxBuffer: 32 * 1024 ** 2 }).trim().split('\n');
    if (entries.length > 100000 || entries.some(name => name.startsWith('/') || name.split('/').includes('..') || /[\0\r]/.test(name))) throw new Error('Source archive has an unsafe path or too many entries.');
    execFileSync('/usr/bin/tar', ['-xzf', source, '-C', directory], { stdio: 'pipe' });
    const profile = { ...prune(directory), inputSha256: digest(fs.readFileSync(source)) };
    const profileFile = path.join(directory, 'PRODUCTION_SOURCE_PROFILE.json');
    fs.writeFileSync(profileFile, JSON.stringify(profile, null, 2) + '\n');
    fs.utimesSync(profileFile, 0, 0);
    fs.utimesSync(directory, 0, 0);
    execFileSync('/usr/bin/tar', ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'wheel', '-czf', destination, '-C', directory, '.'], { stdio: 'pipe' });
    return profile;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
module.exports = { prune, projectArchive };
