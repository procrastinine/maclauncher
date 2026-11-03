const { withFileLock, acquireFileLock } = require("../shared/file-lock");
module.exports = { withCatalogLock: withFileLock, acquireCatalogLock: acquireFileLock };
