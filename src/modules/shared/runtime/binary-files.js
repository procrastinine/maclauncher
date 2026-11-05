const fs = require('node:fs'), path = require('node:path');
const { inspectFile } = require('./translator-description');

// Choose by actual machine/slices, independently of a publisher's folder names.
// Both compatibility and materialization consume this exact file set.
function binaryFiles(files, { machine, architecture } = {}) {
  const groups = new Map(), selected = [], missing = [];
  for (const file of files) {
    const actual = fs.existsSync(file.path) ? inspectFile(file) : file;
    const key = `${actual.format}:${path.basename(actual.path)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(actual);
  }
  for (const rows of groups.values()) {
    const format = rows[0].format;
    const matches = format === 'pe' && machine ? rows.filter(file => file.machine === machine)
      : format === 'macho' && architecture ? rows.filter(file => file.cpuSlices?.includes(architecture)) : rows;
    if (matches.length) selected.push(matches[0]);
    else missing.push({ file: rows[0], reason: format === 'pe' ? `No PE machine ${machine} for ${path.basename(rows[0].path)}` : `No ${architecture} CPU slice for ${path.basename(rows[0].path)}` });
  }
  return { files: selected, missing };
}
module.exports = { binaryFiles };
