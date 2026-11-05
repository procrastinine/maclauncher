const fs = require('node:fs'), path = require('node:path');
const { readMachOLoadCommands } = require('./macho-load-commands');
const { normalizeArchitecture } = require('./architecture');

function wineLayout(install) {
  const root = install.crossoverRoot || install.engineRoot || install.wineRoot || path.dirname(path.dirname(install.executablePath));
  const dllRoot = path.join(root, 'lib/wine');
  let directories = []; try { directories = fs.readdirSync(dllRoot).sort(); } catch {}
  const candidates = directories.filter(name => name.endsWith('-unix') && fs.existsSync(path.join(dllRoot, name, 'ntdll.so')));
  const preferred = normalizeArchitecture(install.architecture || install.architectures?.[0]);
  const rows = candidates.map(name => {
    let architectures = []; try { architectures = readMachOLoadCommands(path.join(dllRoot, name, 'ntdll.so')).architectures; } catch {}
    return { name, architectures };
  });
  const selected = rows.find(row => row.architectures.some(cpu => normalizeArchitecture(cpu) === preferred)) || rows[0];
  const unixName = selected?.name || null, architecture = selected?.architectures.find(cpu => normalizeArchitecture(cpu) === preferred) || selected?.architectures[0] || null;
  const windows = directories.filter(name => name.endsWith('-windows'));
  const primaryWindows = windows.find(name => name.slice(0, -8) === unixName?.slice(0, -5)) || windows.find(name => name !== 'i386-windows') || windows[0];
  return { root, dllRoot, unixName, unixRoot: unixName ? path.join(dllRoot, unixName) : null,
    architecture, windows, primaryWindows, primaryWindowsRoot: primaryWindows ? path.join(dllRoot, primaryWindows) : null };
}
function wineRoot(root) {
  if (fs.existsSync(path.join(root, 'wine'))) return path.join(root, 'wine');
  return root;
}
module.exports = { wineLayout, wineRoot };
