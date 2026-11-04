const fs = require("node:fs"), path = require("node:path");

// The declared rpgmakermlinux-cicpoffs source supplies Onsyuri's real UmePlus
// font. Include it as a game-authored input when launching a temporary game
// directly, without the launcher's consented prerequisite installation flow.
module.exports = gameRoot => fs.copyFileSync(path.join(__dirname,
  "../../src/external/rpgmakermlinux-cicpoffs/nwjs/nwjs/packagefiles/onsyuri/umeplus-gothic.ttf"),
path.join(gameRoot, "default.ttf"), fs.constants.COPYFILE_FICLONE);
