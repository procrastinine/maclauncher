const { githubMacReleases, recognizeMacRelease } = require("../../shared/runtime/publisher-app");

const SOURCE_URL = "https://github.com/UZDoom/UZDoom/releases";
const source = githubMacReleases("UZDoom/UZDoom");

module.exports = { SOURCE_URL, source, recognize: recognizeMacRelease };
