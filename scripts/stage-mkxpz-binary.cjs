#!/usr/bin/env node
const { createStagingInput } = require("../src/modules/rgss/runtime/binary-package");
const { stagePackage } = require("./stage-native-runtimes.cjs");

async function main(args) {
  const options = {}, allowed = new Set(["app", "output", "arch", "maximum-macos", "sign-identity"]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.slice(2);
    if (!args[index]?.startsWith("--") || !allowed.has(key) || !args[index + 1] || options[key]) {
      throw new Error("Usage: node scripts/stage-mkxpz-binary.cjs --app <Z-universal.app> --output <directory> --arch arm64|x64 [--maximum-macos 13.0] [--sign-identity <identity>]");
    }
    options[key] = args[index + 1];
  }
  if (!options.app || !options.output || !["arm64", "x64"].includes(options.arch)) {
    throw new Error("Provide the publisher app, staging directory and explicit arm64 or x64 architecture.");
  }
  const staged = await stagePackage(createStagingInput(options.app), { outputRoot: options.output,
    arch: options.arch, maximumMacOS: options["maximum-macos"] || "13.0", signingIdentity: options["sign-identity"] || "-" });
  console.log(JSON.stringify(staged));
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
