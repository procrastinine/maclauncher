const { githubMacReleases, recognizeMacRelease } = require("../../shared/runtime/publisher-app");

const SOURCE_URL = "https://github.com/ZDoom/Raze/releases";
const source = githubMacReleases("ZDoom/Raze");

module.exports = { SOURCE_URL, source, recognize: recognizeMacRelease };
