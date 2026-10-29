const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Writable = require("../shared/writable-input");
const { validate } = require("../shared/runtime/launch-arguments");

const ENVIRONMENT = "MACLAUNCHER_GAME_ARGUMENTS";
const INTENT_EXTRA = "maclauncher.arguments";
function serialized(context) {
  const values = validate(context?.gameArguments || []);
  return values.length ? JSON.stringify(values) : null;
}
function environment(context, base = {}) {
  const result = { ...base }, value = serialized(context);
  delete result[ENVIRONMENT];
  if (value != null) result[ENVIRONMENT] = value;
  return result;
}
function prepareAgent(context) {
  if (serialized(context) == null) return null;
  const bytes = fs.readFileSync(require("./included-files").file("resources/launch-arguments.jar"));
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const directory = path.join(context.userDataDir, "runtimes/android-arguments", digest);
  Writable.assertOwnDirectory(context.userDataDir, directory);
  const file = path.join(directory, "arguments.jar");
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || !fs.readFileSync(file).equals(bytes))
    Writable.atomicWrite(file, bytes, { root: directory });
  return file;
}
function jvmOptions(file, provider = "jvm") {
  return file ? ["--add-exports=java.base/jdk.internal.org.objectweb.asm=ALL-UNNAMED", `-javaagent:${file}=${provider}`] : [];
}
function processOptions(context, options, serviceProcess = false) {
  return { ...options, env: environment(serviceProcess ? {} : context, options.env),
    ...(serviceProcess ? { gameArguments: false } : {}) };
}
module.exports = { ENVIRONMENT, INTENT_EXTRA, serialized, environment, prepareAgent, jvmOptions, processOptions };
