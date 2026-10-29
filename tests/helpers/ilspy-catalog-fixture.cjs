const Catalog = require('../../src/modules/shared/runtime/ilspy-catalog');
const entries = Object.fromEntries([['9.1.0.7988', 'net8.0'], ['11.1.0.9782', 'net10.0']].map(([version, framework]) => [version,
  { version, framework, minimumRuntime: framework.slice(3) + '.0', sourceRevision: 'a'.repeat(40),
    url: Catalog.packageUrl(version), sourceUrl: Catalog.SOURCE + '/' + version, sha256: 'b'.repeat(64), ...Catalog.PINS[version] }]));
module.exports = { entries };
