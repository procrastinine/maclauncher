"use strict";
// Starts an Electron game's own app: its package.json, main-process script and
// the preload scripts its windows name. MacLauncher's Electron reaches this file
// through bootstrap.js; a downloaded Electron runs it as its default app. It
// sets up what Electron sets up for a packaged app in resources/app before that
// app's main script runs.
//
// Downloaded Electron releases back to the oldest ones run this file, so it
// uses only syntax their Node versions read.
var fs = require("fs");
var path = require("path");
var Module = require("module");

var APP_FLAG = "maclauncher-electron-app";
var ARGUMENTS_FLAG = "maclauncher-game-arguments";
var ICON_FLAG = "maclauncher-dock-icon";

function argumentValue(argv, name) {
  var prefix = "--" + name + "=";
  for (var index = 0; index < argv.length; index++) {
    if (typeof argv[index] === "string" && argv[index].indexOf(prefix) === 0) return argv[index].slice(prefix.length);
  }
  return null;
}

function gameArguments(argv) {
  var encoded = argumentValue(argv, ARGUMENTS_FLAG);
  if (encoded === null) return [];
  var decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  if (!Array.isArray(decoded) || decoded.some(function (value) { return typeof value !== "string"; })) {
    throw new Error("Invalid game launch arguments.");
  }
  return decoded;
}

// Inside app.asar, Electron's file system reads the archive.
function readPackage(appRoot) {
  var parsed = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The game's package.json does not describe an app.");
  return parsed;
}

function attempt(action) {
  try { action(); } catch (error) { /* An Electron release without this setting keeps its own value. */ }
}

function start(options) {
  options = options || {};
  var electron = options.electron || require("electron");
  var app = electron.app;
  var argv = options.argv || process.argv;
  var appRoot = argumentValue(argv, APP_FLAG);
  if (!appRoot || !path.isAbsolute(appRoot)) throw new Error("An absolute Electron app path is required: --" + APP_FLAG + "=/path/to/app");
  var args = gameArguments(argv);
  var iconPath = argumentValue(argv, ICON_FLAG);
  var packageJson = readPackage(appRoot);

  // The app's name and version replace those of the Electron that runs it. Its
  // data folder follows the name, as it does for a packaged app.
  if (typeof packageJson.version === "string" && packageJson.version) attempt(function () { app.setVersion(packageJson.version); });
  var name = String(packageJson.productName || packageJson.name || "").trim();
  if (name) {
    attempt(function () { app.setName(name); });
    attempt(function () { app.setPath("userData", path.join(app.getPath("appData"), name)); });
  }
  if (typeof packageJson.v8Flags === "string" && packageJson.v8Flags) require("v8").setFlagsFromString(packageJson.v8Flags);
  app.setAppPath(appRoot);
  // A packaged app finds the files beside app or app.asar through resourcesPath,
  // which recent Electron releases define as read-only.
  attempt(function () {
    Object.defineProperty(process, "resourcesPath", { value: path.dirname(appRoot), enumerable: true, configurable: true, writable: false });
  });
  // The app reads only its own arguments. An Electron started as a default app
  // keeps the app's path as the first one, as Electron does for `electron app`.
  process.argv = [process.execPath].concat(process.defaultApp ? [appRoot] : [], args);

  if (iconPath && app.dock) {
    var showIcon = function () { attempt(function () { app.dock.setIcon(iconPath); }); };
    if (app.isReady()) showIcon(); else app.once("ready", showIcon);
  }

  var main = path.join(appRoot, typeof packageJson.main === "string" && packageJson.main.trim() ? packageJson.main.trim() : "index.js");
  if (packageJson.type === "module" || /\.mjs$/i.test(main)) {
    // ES module apps run on Electron releases with ES module support. The
    // import is built at run time so older releases still read this file.
    var load = new Function("specifier", "return import(specifier)");
    return load(require("url").pathToFileURL(Module._resolveFilename(main, null, true)).href);
  }
  return Module._load(main, module, true);
}

if (require.main === module || process.argv.some(function (value) { return typeof value === "string" && value.indexOf("--" + APP_FLAG + "=") === 0; })) {
  start();
}

module.exports = { start: start, argumentValue: argumentValue, gameArguments: gameArguments, APP_FLAG: APP_FLAG, ARGUMENTS_FLAG: ARGUMENTS_FLAG, ICON_FLAG: ICON_FLAG };
