const fs = require('node:fs');
// Exercise same-inode, same-size writes whose coarse filesystem times do not
// change. Preserve real descriptor/type/mode facts and all bytes in these tests.
function holdFileTimes(t, files) {
  const names = new Set(files.map(String)), inodes = new Set(files.map(file => {
    const stat = fs.statSync(file); return `${stat.dev}:${stat.ino}`;
  }));
  const held = stat => {
    const result = Object.assign(Object.create(Object.getPrototypeOf(stat)), stat);
    for (const key of ['mtimeMs', 'ctimeMs']) result[key] = typeof stat[key] === 'bigint' ? 1700000000000n : 1700000000000;
    for (const key of ['mtimeNs', 'ctimeNs']) if (key in stat) result[key] = 1700000000000000000n;
    return result;
  };
  for (const method of ['statSync', 'lstatSync', 'fstatSync']) {
    const original = fs[method];
    t.mock.method(fs, method, (file, ...args) => {
      const stat = original(file, ...args);
      return stat && (names.has(String(file)) || method === 'fstatSync' && inodes.has(`${stat.dev}:${stat.ino}`)) ? held(stat) : stat;
    });
  }
}
module.exports = { holdFileTimes };
