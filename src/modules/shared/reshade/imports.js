const fs = require("node:fs"), path = require("node:path");
const Filters = require("./filter-library");

function kindForPath(input) {
  if (typeof input !== "string" || !path.isAbsolute(input) || /[\x00-\x1f]/.test(input)) return null;
  let file = input; try { file = fs.realpathSync(input); } catch {}
  if (require('./neural/models').packagePattern.test(file) || /\.(?:safetensors|pth)$/i.test(file)) return "neural-model";
  if (/\.(app|zip)$/i.test(file) && require("./neural/model-sources").recognizes(file)) return "neural-model";
  return Filters.formatForPath(file) ? "filter" : null;
}
function importFilters(userDataDir, files) {
  return Filters.importFiles(userDataDir, files);
}
function createImporter({ userDataDir, importGame, importModel, onGraphicsImported = () => {} }) {
  return async (input, options = {}) => {
    const kind = kindForPath(input);
    if (!kind) return importGame(input, options);
    let result;
    if (kind === "filter") {
      const file = fs.realpathSync(input), filters = importFilters(userDataDir, [input]);
      result = { kind, path: input, filter: filters.find(row => {try{return fs.realpathSync(row.path)===file;}catch{return false;}}), filters };
    } else {
      result = { kind, model: await importModel(input, options) };
    }
    await onGraphicsImported(result, options);
    return result;
  };
}
module.exports = { kindForPath, importFilters, createImporter };
