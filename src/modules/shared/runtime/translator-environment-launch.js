"use strict";

// Launch side of translator environments. Declarations come from every
// module's translator-environment.js through the registry; global values are
// in the launcher settings and a game's values are in its record.
const Contract = require("./translator-environment.mjs");

function declarations(options = {}) {
  if (Array.isArray(options.declarations)) return options.declarations;
  return require("../../registry").listTranslatorEnvironments();
}

// The values a launch adds for the chosen translators. `earlier` holds values
// per translator from a runtime's earlier per-game environment setting.
function forLaunch(entry, context, ids, options = {}) {
  return Contract.launchValues(declarations(options), ids, {
    global: context?.settings?.launcher?.translatorEnvironment,
    game: entry?.translatorEnvironment,
    earlier: options.earlier
  });
}

// `environment` with the chosen translators' values applied. Names in
// `required` keep the launcher's value.
function apply(environment, entry, context, ids, options = {}) {
  return Contract.applyEnvironment(environment, forLaunch(entry, context, ids, options).values, { required: options.required });
}

module.exports = { declarations, forLaunch, apply, valuesFromLines: Contract.valuesFromLines };
