const test = require('node:test');
const assert = require('node:assert/strict');
const { projectSources } = require('../src/modules/shared/runtime/runtime-sources');
const catalog = { versions: ['owned', 'stock', 'windows'], installable: false, installableVersions: ['owned', 'stock'],
  versionRequirements: { owned: {minimumMacOS:'13.0'}, stock: {minimumMacOS:'26.0'}, windows: {installReason:'Windows only'} },
  versionLabels: {owned:'Adapted Mac',stock:'Publisher Mac'}, recommendedVersion:'owned' };
const pins = [{version:'owned', projectPackage:{}}, {version:'stock',asset:{}}, {version:'windows'}];
test('source lists keep real Mac providers separate and exclude other-platform tags from summaries', () => {
  const view = projectSources(catalog, pins, {projectId:'sample',upstreamUrl:'https://example.test/releases',upstreamDownloads:true});
  assert.deepEqual(view.versions,['owned','stock']);
  assert.deepEqual(view.sources.map(source=>[source.id,source.versions,source.installable]),[['builds',['owned'],true],['upstream',['stock'],true]]);
  assert.equal(view.sources[0].source,'https://procrastinine.github.io/maclauncher-builds/#sample');
  assert.deepEqual(Object.keys(view.sources[1].versionRequirements),['stock']);
  assert.deepEqual(view.sources[1].versionLabels,{stock:'Publisher Mac'});
});
test('Builds-only Mac delivery links to upstream code without inventing an upstream download list', () => {
  const view = projectSources(catalog,pins,{projectId:'sample',upstreamUrl:'https://example.test/source'});
  assert.deepEqual(view.versions,['owned']); assert.equal(view.sources.length,1);
  assert.deepEqual(view.sourceLinks,[{label:'upstream code',url:'https://example.test/source'}]);
});
test('cold source headers contain links without seeded versions or install capability', () => {
  const view = projectSources({...catalog,versions:[],installableVersions:[]},pins,{projectId:'sample',upstreamUrl:'https://example.test/releases',upstreamDownloads:true});
  assert.deepEqual(view.sources.map(source=>source.versions),[[],[]]);
  assert(view.sources.every(source=>source.installable===false));
});
test('provider summaries list published rows without ranking or recommending a package version', () => {
  const versions=['99.0-beta1','8.0','7.0','6.0'];
  const view=projectSources({versions,installableVersions:versions,versionRequirements:{'8.0':{installReason:'Requires a newer host'}}},
    versions.map(version=>({version,projectPackage:{}})),{projectId:'sample'});
  assert.equal(view.recommendedVersion,null); assert.equal(view.latestAvailableVersion,null);
  assert.equal(view.sources[0].recommendedVersion,null); assert.deepEqual(view.sources[0].versions,versions);
});
