// Size, count and output-buffer guards protect the live app from unexpected
// input. MacLauncher Builds produces packages from these same modules with
// MACLAUNCHER_PACKAGE_PRODUCER=1, which lifts the guards for that process.
const PRODUCER_ENV = "MACLAUNCHER_PACKAGE_PRODUCER";

function producing() {
  return process.env[PRODUCER_ENV] === "1";
}

/** A numeric guard: the live value, or Infinity while producing packages. */
function limit(value) {
  return producing() ? Infinity : value;
}

/** A caller-supplied limit: unchanged live, absent while producing packages. */
function optional(value) {
  return producing() ? undefined : value;
}

/** A frozen table of numeric guards whose fields read through limit(). */
function limits(values) {
  return Object.freeze(Object.defineProperties({}, Object.fromEntries(Object.entries(values).map(([key, value]) =>
    [key, { enumerable: true, get: () => limit(value) }]))));
}

module.exports = { PRODUCER_ENV, producing, limit, optional, limits };
