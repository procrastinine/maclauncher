const { createCheatsHelpers } = require("../../shared/cheats/cheats");

const cheatsSchema = require("./schema.json");
const cheatsHelpers = createCheatsHelpers(cheatsSchema);

module.exports = {
  cheatsSchema,
  cheatsHelpers
};
