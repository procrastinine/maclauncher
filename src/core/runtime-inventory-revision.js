// A backend lane's count of runtime inventory changes. The lane advances it
// when it, or another lane, reports changed runtimes, settings or installed
// rows, so display inventories can be reused until the next change. Outside a
// backend lane no revision exists and nothing is reused.
let revision = 0, active = false;
const EVENTS = new Set(["runtimeChanged", "runtimeInventoryChanged", "settingsChanged"]);
module.exports = {
  EVENTS,
  activate() { active = true; },
  advance() { revision += 1; },
  current: () => active ? revision : null
};
