'use strict';
const path = require('node:path');
const { validate } = require('../modules/shared/runtime/launch-arguments');

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

// Parts are admitted by the execution plan. Host and Windows libraries remain
// in the same build; this adapter does not choose a CPU or a Wine source.
function windowsPath(file) {
  return '\\\\?\\unix' + file.split(path.sep).join('\\');
}
function apply({ build, parts, environment = {}, parameters = {} }) {
  if (!parts?.native) throw new Error('The Steam bridge plan has no admitted native host library.');
  for (const name of ['builtin', 'bootstrap', 'helper'])
    if (!parts[name]) throw new Error(`The Steam bridge plan has no admitted ${name} library.`);
  const extra = {
    WINEDLLPATH: [...new Set([build.root, ...String(environment.WINEDLLPATH || '').split(path.delimiter).filter(Boolean)])].join(path.delimiter),
    WINEDLLOVERRIDES: [environment.WINEDLLOVERRIDES, 'lsteamclient=b'].filter(Boolean).join(';'),
    SteamAppId: String(parameters.appId), SteamGameId: String(parameters.appId),
    STEAM_COMPAT_CLIENT_INSTALL_PATH: parameters.clientRoot,
    MACLAUNCHER_STEAM_BOOTSTRAP: windowsPath(parts.bootstrap),
    MACLAUNCHER_STEAM_BUILTIN: windowsPath(parts.builtin),
    ...Object.fromEntries(Object.entries(parts.clients || {}).map(([name, file]) => [name, windowsPath(file)])),
    HOME: parameters.home, CFFIXED_USER_HOME: parameters.home
  };
  const prepared = { ...environment, ...extra, WINEPREFIX: parameters.prefixPath };
  delete prepared.STEAM_DYLD_INSERT_LIBRARIES;
  delete prepared.NOTPROTON_OVERLAY_SHIM;
  return { environment: prepared, extra, helper: windowsPath(parts.helper), nativeLibrary: parts.native,
    appId: String(parameters.appId), packageVersion: build.version };
}
module.exports = { apply, windowsPath, windowsArguments };
