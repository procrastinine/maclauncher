// The Wine sources MacLauncher runs Windows games with. Each descriptor states
// only what differs per source: where its Wine tree comes from, its layout and
// included translators, and its Runtimes row. Every other part of preparing and
// launching a game is shared.
const IDS = Object.freeze(["crossover", "sikarugir", "winecx"]);
const loaded = new Map();
function get(id) {
  if (!IDS.includes(id)) return null;
  if (!loaded.has(id)) loaded.set(id, require(`./${id}`));
  return loaded.get(id);
}
const all = () => IDS.map(get);
const forEnvironmentKind = kind => all().find(source => source.environmentKind && source.environmentKind === kind) || null;
module.exports = { IDS, get, all, forEnvironmentKind };
