const Writable = require("../shared/writable-input");

// Ren'Py accepts the selected project directly. Older private views stay on
// disk, but they are not launch inputs or write destinations.
function prepareInput(entry) {
  return Writable.sourceEntry(entry);
}

module.exports = { prepareInput };
