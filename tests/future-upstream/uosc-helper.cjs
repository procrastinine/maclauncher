const publisher = require("./mpv-plugins.cjs");

// The native helper uses uosc's ZIP releases. thumbfast's separate commit
// history belongs only to the plugin manager.
const { newCommit, ...scenarios } = publisher.scenarios;
module.exports = { managers: ["uosc-helper"], current: publisher.current, scenarios };
