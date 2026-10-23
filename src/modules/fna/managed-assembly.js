// Retain the module's existing import path; PE/CLI inspection is shared by
// managed engines and never loads or executes a game assembly.
module.exports = require("../shared/runtime/managed-assembly");
