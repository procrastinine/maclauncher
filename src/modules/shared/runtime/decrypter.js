const Manager = require("./decrypter-manager");

async function resolveDecrypterBinary({ entry = {}, payload = {}, context = {} } = {}) {
  return (await Manager.ensure(entry, payload, context)).executablePath;
}

module.exports = { resolveDecrypterBinary };
