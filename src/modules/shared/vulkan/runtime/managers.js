module.exports = [...require("../libraries").managers, require("../loader-manager").manager, ...require("../managed").providers.map(item => item.manager)];
