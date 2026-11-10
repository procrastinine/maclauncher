// Generates demo/data/state.json when it is missing, before `pnpm dev` and
// `pnpm build`: first the included runtime packages the generator reads
// (inputs.cjs), then the data itself, as `pnpm run demo:data` does.
// The file is not checked in; `pnpm run demo:data` regenerates it after
// module, runtime or effect changes.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const state = path.join(__dirname, "state.json");
const website = path.resolve(__dirname, "../..");

async function main() {
  if (fs.existsSync(state)) return;
  const inputs = await require("./inputs.cjs").prepare();
  if (inputs.fetched) console.log(`Included runtime packages: ${inputs.packages} locked, ${inputs.fetched} fetched`);
  execFileSync(process.execPath, ["--require", path.join(__dirname, "host.cjs"), path.join(__dirname, "generate.cjs")],
    { cwd: website, stdio: "inherit", env: { ...process.env, NODE_PATH: path.join(website, "node_modules") } });
  console.log(`Generated ${path.relative(website, state)}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
