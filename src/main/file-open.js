const { createGameImportQueue } = require("../core/game-import-queue");

// Shared by the early Apple-event listener and the launcher IPC/menu adapters.
const gameImports = createGameImportQueue();
module.exports = { gameImports };
