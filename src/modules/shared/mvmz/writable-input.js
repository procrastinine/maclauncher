const Writable = require("../writable-input");

// Imported projects are ordinary mutable games; Play creates no second tree.
function prepareInput(entry, context = {}) {
  context.signal?.throwIfAborted();
  return Writable.sourceEntry(entry);
}

module.exports = { prepareInput };
