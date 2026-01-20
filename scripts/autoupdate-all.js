const { updateMkxpzEmbedded } = require("./autoupdate-mkxpz");

async function updateAllEmbedded({ logger = console } = {}) {
  const results = {
    mkxpz: await updateMkxpzEmbedded({ logger })
  };
  logger?.info?.("[autoupdate] embedded resources checked.");
  return results;
}

if (require.main === module) {
  updateAllEmbedded().catch(err => {
    console.error(err?.message || err);
    process.exitCode = 1;
  });
}

module.exports = { updateAllEmbedded };
