// A backend lane's count of runtime inventory changes. The lane advances it
// when it, or another lane, reports changed runtimes, settings or installed
// rows, so display inventories can be reused until the next change. Outside a
// backend lane no revision exists and nothing is reused.
//
// The inspector's lane also keeps its reads of installed runtimes, such as
// listed installations and verified app bundles, until the count changes
// (`retained`). Other lanes read them again for every request: the state lane
// detects changes made outside the launcher, and Play checks what it runs.
let revision = 0, active = false, retain = false;
const EVENTS = new Set(["runtimeChanged", "runtimeInventoryChanged", "settingsChanged"]);
module.exports = {
  EVENTS,
  activate({ retainReads = false } = {}) { active = true; retain = retainReads === true; },
  advance() { revision += 1; },
  current: () => active ? revision : null,
  retained: () => active && retain ? revision : null
};
