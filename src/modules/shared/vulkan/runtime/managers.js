module.exports = [...require("../libraries").managers, ...require("../managed").providers.map(item => item.manager)];
