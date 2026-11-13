const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 });

// The repositories this one pins never pin it back: every pinned commit's .gitmodules
// is read from its initialized checkout and names no repository called like this one.
test('no pinned repository pins this repository back', () => {
  const name = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name;
  const gitlinks = git(root, 'ls-files', '-s', '-z').split('\0').filter(row => row.startsWith('160000 '))
    .map(row => { const [header, file] = row.split('\t'); return { file, commit: header.split(' ')[1] }; });
  for (const { file, commit } of gitlinks) {
    const checkout = path.join(root, file);
    if (!fs.existsSync(path.join(checkout, '.git'))) continue;
    let listing = '';
    try { listing = git(checkout, 'config', '--blob', commit + ':.gitmodules', '--get-regexp', '^submodule\\..*\\.url$'); } catch { continue; }
    for (const line of listing.split('\n').filter(Boolean)) {
      const repository = line.slice(line.indexOf(' ') + 1).trim().replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop().toLowerCase();
      assert.notEqual(repository, name, `${file} at ${commit.slice(0, 10)} pins ${name} back: ${line}`);
    }
  }
});
