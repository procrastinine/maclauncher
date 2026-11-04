const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Content = require('./runtime-content.cjs'), Native = require('./native-binary-tools.cjs');
const MachO = require('../src/modules/shared/runtime/macho-load-commands'), { execFileSync } = require('node:child_process');
const root = path.resolve(process.argv[2]), cpu = process.argv[3] === 'x64' ? 'x86_64' : process.argv[3];
const files = [], members = [], hashes = new Map(), images = new Map();
const warning = text => console.log('::warning::' + text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A'));
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else { members.push(file); if (entry.isFile()) files.push(file); }
  }
}
function record(name, hash) {
  if (hashes.has(hash)) warning(`Identical files: ${hashes.get(hash)} and ${name}`);
  else hashes.set(hash, name);
  const reason = Content.excludedReason(name);
  if (reason) warning(`${reason}: ${name}`);
}
async function main() {
  walk(root);
  for (const file of files) {
    const hash = crypto.createHash('sha256');
    for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
    const name = path.relative(root, file);
    record(name, hash.digest('hex'));
    const architectures = Native.macho(file);
    if (architectures) images.set(file, MachO.readMachOLoadCommands(file));
    if (file.endsWith('.asar')) {
      const asar = require('@electron/asar');
      for (const member of asar.listPackage(file).map(name => name.replace(/^\//, ''))) {
        const item = asar.statFile(file, member, false);
        if (!item.files && !item.link && !item.unpacked) record(name + '/' + member, crypto.createHash('sha256').update(asar.extractFile(file, member)).digest('hex'));
      }
    }
  }
  const executables = [...images].filter(([, info]) => info.slices.some(slice => slice.fileType === 2)).map(([file]) => path.dirname(file));
  const contained = file => fs.existsSync(file) && fs.realpathSync(file).startsWith(root + path.sep);
  for (const [file, info] of images) {
    if (!info.architectures.includes(cpu)) warning(`Mach-O has no ${cpu} slice: ${path.relative(root, file)}`);
    const fd = fs.openSync(file, 'r');
    const links = Native.parseLinkedLibraries(execFileSync('/usr/bin/otool', ['-L', '/dev/fd/3'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd] }));
    fs.closeSync(fd);
    for (const link of links) {
      if (link.startsWith('/usr/lib/') || link.startsWith('/System/')) continue;
      const resolved = link.startsWith('@rpath/') ? members.some(candidate => candidate.endsWith('/' + link.slice(7)) && contained(candidate)) :
        link.startsWith('@executable_path/') ? executables.some(directory => contained(path.resolve(directory, link.slice(17)))) :
          contained(link.replace(/^@loader_path/, path.dirname(file)));
      if (!resolved) warning(`Library outside output: ${path.relative(root, file)} links ${link}`);
    }
  }
  process.exitCode = 0;
}
main();
