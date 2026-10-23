const { fetchMkxpzCandidate, parseArguments, usage } = require("./autoupdate-mkxpz");

async function updateAllEmbedded({ logger = console, ...options } = {}, dependencies) {
  const results = {
    mkxpz: await fetchMkxpzCandidate({ logger, ...options }, dependencies)
  };
  logger?.info?.("[autoupdate] maintainer candidates checked; Included pins and payloads stay unchanged.");
  return results;
}

async function main(args, dependencies) {
  const options = parseArguments(args);
  if (options.help) { console.log(usage("scripts/autoupdate-all.js")); return null; }
  return updateAllEmbedded(options, dependencies);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => {
    console.error(err?.message || err);
    process.exitCode = 1;
  });
}

module.exports = { updateAllEmbedded, main };
