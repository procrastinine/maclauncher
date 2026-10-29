const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { renderToStaticMarkup } = require('react-dom/server');
const { react, componentHarness } = require('./helpers/renderer-component');
let RuntimeCatalogSources;
test.before(async () => {
  const bundle = await require('vite').build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.resolve(__dirname, '../src/renderer/src/ui/components/RuntimeCatalogSources.tsx'), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, 'runtime-catalog-empty.cjs'), module);
  compiled.paths = module.paths;
  compiled.require = id => id === 'react' ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  RuntimeCatalogSources = compiled.exports.RuntimeCatalogSources;
});
function elements(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(elements)];
}
function fixture(catalog) {
  const refreshed = [], selected = [], installed = [];
  const props = { managerId: 'fixture', section: { id: 'default', installed: [], catalog },
    ui: { installVersion: {}, pendingActions: {} }, busy: false, variant: '', downloads: [],
    onSelect: (...args) => selected.push(args), onInstall: (...args) => installed.push(args),
    onRefresh: options => refreshed.push(options) };
  const harness = componentHarness(RuntimeCatalogSources, props);
  return { props, harness, refreshed, selected, installed };
}
test('an empty source loads only on its labeled action and preserves latest-only/full requests', () => {
  const f = fixture({ status: 'idle', versions: [], supportsLatestOnly: true, source: 'https://github.com/example/runtime/actions' });
  try {
    const tree = f.harness.render(), html = renderToStaticMarkup(tree);
    assert.deepEqual(f.refreshed, []);
    assert.match(html, />Load versions<\/button>/);
    assert.doesNotMatch(html, /<select|No versions loaded|iconOnly runtimeRefresh/);
    assert.match(html, /Development builds from the project/);
    elements(tree).find(node => node.type === 'button' && node.props.children === 'Load versions').props.onClick();
    elements(tree).find(node => node.type === 'button' && node.props.children === 'All versions').props.onClick();
    assert.deepEqual(f.refreshed, [{ latestOnly: true }, { latestOnly: false }]);
    f.props.section.catalog.status = 'loading';
    const loading = f.harness.render();
    assert.equal(elements(loading).find(node => node.type === 'button' && node.props.children === 'Loading versions…').props.disabled, true);
    assert.match(renderToStaticMarkup(loading), /role="status">Refreshing versions/);
  } finally { f.harness.close(); }
});
test('explicit sources keep independent load actions, errors and descriptions', () => {
  const f = fixture({ sources: [
    { id: 'packages', label: 'Packages', source: 'https://example.com/releases', description: 'Portable runtime packages.', status: 'error', error: 'Connection failed.', versions: [] },
    { id: 'workflow', label: 'Development', source: 'https://github.com/example/runtime/actions', status: 'success', versions: [] }
  ] });
  try {
    const tree = f.harness.render(), html = renderToStaticMarkup(tree);
    assert.match(html, /Portable runtime packages/);
    assert.match(html, /Connection failed/);
    assert.match(html, /No downloadable versions found at this source/);
    elements(tree).find(node => node.type === 'button' && node.props['aria-label'] === 'Load Packages versions').props.onClick();
    assert.deepEqual(f.refreshed, [{ sourceId: 'packages' }]);
  } finally { f.harness.close(); }
});
test('populated catalogs preserve saved exact choices and normal install and refresh controls', () => {
  const f = fixture({ status: 'success', versions: ['2.0', '1.0'], source: 'https://github.com/example/runtime/releases', installable: true });
  f.props.ui.installVersion.default = '1.0';
  try {
    const tree = f.harness.render(), html = renderToStaticMarkup(tree);
    assert.match(html, /Releases published by the runtime project/);
    assert.match(html, /aria-label="Reload versions"/);
    assert.doesNotMatch(html, />Load versions<\/button>/);
    const menu = elements(tree).find(node => node.props?.['aria-label'] === 'Version' && node.props.onChange);
    assert.equal(menu.props.value, '1.0');
    assert.match(html, /title="v1\.0 \(1\.0\)"/);
    menu.props.onChange({ target: { value: '2.0' } });
    assert.deepEqual(f.selected, [['default', 'installVersion', '2.0']]);
    elements(tree).find(node => node.type === 'button' && node.props.children === 'Install').props.onClick();
    assert.deepEqual(f.installed, [['1.0', undefined]]);
  } finally { f.harness.close(); }
});
