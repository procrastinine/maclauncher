const { publisher } = require("./scummvm.cjs");

module.exports = { managers: ["scummvm-tools"], ...publisher({ folder: "https://downloads.scummvm.org/frs/scummvm-tools/", prefix: "scummvm-tools" }) };
