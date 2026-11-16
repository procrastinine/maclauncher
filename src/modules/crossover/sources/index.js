// The Wine sources MacLauncher runs Windows games with. Each descriptor states
// only what differs per source: where its Wine tree comes from, its layout and
// included translators, and its Runtimes row. Every other part of preparing and
// launching a game is shared.
const definitions = require('../../../runtime-sources').loadSources().filter(source => source.kind === 'wine').sort((a,b) => a.order - b.order);
const IDS = Object.freeze(definitions.map(source => source.id));
const loaded = new Map();
function get(id) {
  if (!IDS.includes(id)) return null;
  // A Wine with its own adapter file supplies its hooks there; any other Wine
  // source is served from its JSON file alone.
  if (!loaded.has(id)) loaded.set(id, require('node:fs').existsSync(require('node:path').join(__dirname, `${id}.js`)) ? require(`./${id}`) :
    require('../../../runtime-adapters/wine').descriptor(id, { manager: () => require('../../../runtime-adapters/wine-release').manager(id),
      dxmtBase: () => null, launchEnvironment: () => ({}) }));
  return loaded.get(id);
}
const all = () => IDS.map(get);
const forEnvironmentKind = kind => all().find(source => source.environmentKind && source.environmentKind === kind) || null;
module.exports = { IDS, get, all, forEnvironmentKind };
