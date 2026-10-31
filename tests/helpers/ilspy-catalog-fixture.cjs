const Catalog = require('../../src/modules/shared/runtime/ilspy-catalog');
const entries = Object.fromEntries([['9.1.0.7988', 'net8.0'], ['11.1.0.9782', 'net10.0']].map(([version, framework]) => [version,
  { version, framework, minimumRuntime: framework.slice(3) + '.0', sourceRevision: 'a'.repeat(40),
    url: Catalog.packageUrl(version), sourceUrl: Catalog.SOURCE + '/' + version, sha256: 'b'.repeat(64) }]));
// A NuGet catalog leaf for one ilspycmd version and target framework.
function metadata(version, framework = 'net10.0') {
  const prefix = 'tools/' + framework + '/any/';
  return { id: 'ilspycmd', version, packageHashAlgorithm: 'SHA512', packageHash: Buffer.alloc(64, 1).toString('base64'),
    packageSize: 1024, repository: { type: 'git', url: 'https://github.com/icsharpcode/ILSpy', commit: entries['11.1.0.9782'].sourceRevision },
    packageEntries: ['ilspycmd.dll', 'ilspycmd.deps.json', 'ilspycmd.runtimeconfig.json', 'ICSharpCode.Decompiler.dll'].map(name => ({ fullName: prefix + name })) };
}
// NuGet's service index, registration and catalog leaves for package metadata,
// as network routes for the test harness.
const BASE = 'https://api.nuget.org/v3/registration5-gz-semver2/';
const leaf = (version, id = 'ilspycmd') => 'https://api.nuget.org/v3/catalog0/data/1/' + id + '.' + version + '.json';
const content = (version, id = 'ilspycmd') => `https://api.nuget.org/v3-flatcontainer/${id}/${version}/${id}.${version}.nupkg`;
function nuget(documents, extra = [], id = 'ilspycmd') {
  const routes = { 'https://api.nuget.org/v3/index.json': { resources: [{ '@type': 'RegistrationsBaseUrl/3.6.0', '@id': BASE }] },
    [BASE + id + '/index.json']: { items: [{ items: [...documents.map(data => ({ packageContent: content(data.version, id),
      catalogEntry: { '@id': leaf(data.version, id), id, version: data.version, listed: true } })), ...extra] }] } };
  for (const data of documents) routes[leaf(data.version, id)] = data;
  return routes;
}
module.exports = { entries, metadata, BASE, leaf, content, nuget };
