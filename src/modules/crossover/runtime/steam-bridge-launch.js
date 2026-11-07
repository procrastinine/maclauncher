const fs = require('node:fs');
const path = require('node:path');
const { readPeVersion } = require('../../shared/runtime/pe-version');
const { readPeResources } = require('../../shared/runtime/pe-resources');
const { readWindowsExecutable } = require('../detect');
const { validate } = require('../../shared/runtime/launch-arguments');

// The bootstrap's embedded command line uses Windows quoting, not shell escapes.
function windowsArguments(text) {
  const args = []; let token = '', quoted = false, started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!quoted && /[ \t]/.test(c)) {
      if (started) args.push(token);
      token = ''; started = false; continue;
    }
    started = true;
    if (c === '\\') {
      let count = 1;
      while (text[i + 1] === '\\') { count++; i++; }
      if (text[i + 1] === '"') {
        token += '\\'.repeat(Math.floor(count / 2)); i++;
        if (count % 2) token += '"';
        else if (quoted && text[i + 1] === '"') { token += '"'; i++; }
        else quoted = !quoted;
      } else token += '\\'.repeat(count);
    } else if (c === '"') {
      if (quoted && text[i + 1] === '"') { token += '"'; i++; }
      else quoted = !quoted;
    }
    else token += c;
  }
  if (quoted) throw new Error('The Windows bootstrap has an unclosed argument quote.');
  if (started) args.push(token);
  return validate(args);
}

function resolve(executablePath, architecture) {
  const unchanged = { executablePath, arguments: [] };
  if (readPeVersion(executablePath)?.strings?.ProductName !== 'BootstrapPackagedGame') return unchanged;
  const resources = readPeResources(executablePath, [{ type: 10, name: 201 }, { type: 10, name: 202 }]);
  const string = name => {
    const rows = resources.filter(row => row.name === name);
    if (!rows.length || rows.some(row => row.data.length % 2)) throw new Error('The Windows bootstrap metadata is missing or invalid.');
    const values = rows.map(row => row.data.toString('utf16le'));
    if (new Set(values).size !== 1 || !values[0].endsWith('\0') || values[0].slice(0, -1).includes('\0'))
      throw new Error('The Windows bootstrap metadata is ambiguous or invalid.');
    return values[0].slice(0, -1);
  };
  const relative = string(201), directory = path.dirname(path.resolve(executablePath));
  const canonicalDirectory = fs.realpathSync(directory);
  if (!relative || /^[\\/]/.test(relative) || /[:]/.test(relative)) throw new Error('The Windows bootstrap target must be inside the game folder.');
  const target = path.resolve(directory, ...relative.split(/[\\/]/));
  if (!target.startsWith(directory + path.sep) || !fs.realpathSync(target).startsWith(canonicalDirectory + path.sep) ||
      readWindowsExecutable(target)?.executableArchitecture !== architecture || target === fs.realpathSync(executablePath))
    throw new Error('The Windows bootstrap target must be a compatible PE executable inside the game folder.');
  // The bridge installs its loader before its immediate child's entry point.
  // Use the publisher's declared program and arguments instead of bootstrapping
  // a launcher whose subsequent child would have no Steam loader installed.
  return { executablePath: target, arguments: windowsArguments(string(202)) };
}
// The program a bootstrap declares, relative to the game folder, or null.
// Metadata errors are left to resolve(), which runs only for bridged launches.
function declaredProgram(executablePath, gameRoot, architecture) {
  let target;
  try { target = resolve(executablePath, architecture).executablePath; } catch { return null; }
  return target === executablePath ? null : path.relative(gameRoot, target).split(path.sep).join('/');
}
module.exports = { resolve, declaredProgram, windowsArguments };
