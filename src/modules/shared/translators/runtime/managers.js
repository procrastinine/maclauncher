const { createManager } = require("../../runtime/translator-managers");
const { definitions } = require("../../runtime/translator-managers");
// Every translator definition except DXMT, whose manager the camera support owns.
module.exports = Object.keys(definitions).filter(engine => !definitions[engine].managerId).map(engine => createManager(engine));
