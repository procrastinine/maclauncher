// Synthetic engine metadata keeps renderer tests independent of modules and real games.
function createLibraryFixture() {
  const supports = { cheats: true, cheatsPatcher: true, saveEditing: true, saveLocation: true };
  const module = {
    id: 'fixture', family: 'fixture', label: 'Fixture engine', shortLabel: 'FX', gameType: 'fixture',
    supports, settingsDefaults: { defaultRuntime: 'managed' },
    runtime: {
      default: 'managed', supported: ['managed', 'native'],
      entries: {
        managed: { label: 'Managed runtime', settings: { fields: [{ key: 'scale', label: 'Scale', type: 'number', default: 1 }] } },
        native: { label: 'Native app' }
      },
      manager: { managed: 'fixture-manager' },
      managerSectionOverrideKey: { managed: 'channel' },
      managerSectionMap: { managed: { stable: 'stable', preview: 'preview' } },
      preLaunch: { managed: { statusAction: 'runtimeStatus', readyWhen: { key: 'ready', truthy: true } } }
    },
    ui: {
      infoFields: [
        { key: 'moduleData.detectedVersion', label: 'Engine version' },
        { key: 'moduleData.extractedPath', label: 'Extracted path', format: 'path' },
        { key: 'moduleData.hidden', label: 'Hidden info', hiddenWhen: [{ key: 'moduleData.hidden', truthy: true }] }
      ],
      actions: [
        { id: 'status', label: 'Refresh status', autoRun: true, resultFields: [{ key: 'value', label: 'Status' }] },
        { id: 'extract', label: 'Extract', kind: 'primary' },
        { id: 'hidden', label: 'Hidden action', hiddenWhen: [{ key: 'moduleData.hidden', truthy: true }] },
        { id: 'disabled', label: 'Disabled action', disabledWhen: [{ key: 'moduleData.hidden', truthy: true }] }
      ],
      actionGroups: [{ id: 'tools', label: 'Engine tools', actions: ['status', 'extract', 'hidden', 'disabled'] }]
    },
    acknowledgments: []
  };
  const recents = Array.from({ length: 24 }, (_, i) => ({
    gameId: `game-${i}`, schemaVersion: 1, order: i, createdAt: 1700000000000 + i * 1000, updatedAt: null,
    gamePath: `/Games/${i === 0 ? 'Alpha' : i === 1 ? 'Beta' : `Game-${i}`}/Game.exe`,
    importPath: null, contentRootDir: null, name: i === 0 ? 'Alpha' : i === 1 ? 'Beta' : `Game ${i}`,
    moduleId: module.id, moduleFamily: module.family, moduleLabel: module.label, moduleShortLabel: module.shortLabel,
    moduleRuntimeSupport: module.runtime.supported, moduleSupports: supports,
    gameType: 'fixture', indexDir: null, indexHtml: null,
    defaultSaveDir: '/Saves/default', saveDirOverride: i === 0 ? '/Saves/custom' : null,
    nativeAppPath: i === 0 ? '/Games/Alpha/Game.app' : null, lastBuiltAt: null,
    runtimeId: 'managed', runtimeData: {}, runtimeSettings: {},
    moduleData: { detectedVersion: '1.0', extractedPath: '/Extracted/' + 'long-folder/'.repeat(15), hidden: true },
    cheats: { enabled: false, gold: 0 }, iconPath: null, iconSource: null, iconUrl: null, lastPlayedAt: null
  }));
  const section = id => ({
    id, label: id === 'stable' ? 'Stable' : 'Preview', defaultVersion: '2.0', defaultVariant: 'arm64',
    installed: [{ version: '2.0', variant: 'arm64' }, { version: '1.0', variant: 'x64' }],
    catalog: { versions: ['2.0', '1.0'] }, variants: [{ id: 'arm64', label: 'Apple Silicon' }, { id: 'x64', label: 'Intel' }]
  });
  return {
    recents, modules: [module], moduleSettings: { fixture: { defaultRuntime: 'managed' } },
    moduleStates: { fixture: {
      cheats: { schema: { defaults: { enabled: false, gold: 0 }, fields: [{ key: 'gold', label: 'Gold', type: 'number', category: 'Stats' }] } },
      libs: { dependencies: [{ id: 'library', label: 'Engine library', defaultVersion: '1', versions: [{ id: '1', label: 'Library 1' }, { id: '2', label: 'Library 2' }] }] }
    } },
    runtimeManagers: { 'fixture-manager': { id: 'fixture-manager', label: 'Fixture runtimes', sections: [section('stable'), section('preview')] } },
    runtimeDefaults: {}, launcherSettings: { showIcons: true, showNonDefaultTags: true,
      library: { version: 1, order: recents.map(game => game.gameId), sort: { mode: 'custom', direction: 'asc' }, favorites: [] } },
    running: {}, downloads: [], debug: false, logPath: '/Logs/launcher.log'
  };
}

function createEngineLibraryFixture() {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', 'src', 'modules');
  const manifests = fs.readdirSync(root).flatMap(id => {
    const file = path.join(root, id, 'manifest.json');
    return fs.existsSync(file) ? [JSON.parse(fs.readFileSync(file, 'utf8'))] : [];
  });
  const fixture = createLibraryFixture();
  const moduleState = fixture.moduleStates.fixture;
  const section = fixture.runtimeManagers['fixture-manager'].sections[0];
  const first = fixture.recents[0];
  fixture.modules = manifests;
  fixture.recents = manifests.map((manifest, index) => ({
    ...first, gameId: `engine-${manifest.id}`, order: index, name: `${manifest.label} test game`,
    gamePath: `/Games/${manifest.id}/` + 'long-folder/'.repeat(index === 0 ? 30 : 1) + 'Game.exe',
    moduleId: manifest.id, moduleLabel: manifest.label, moduleShortLabel: manifest.shortLabel,
    moduleSupports: manifest.supports, moduleRuntimeSupport: manifest.runtime.supported,
    runtimeId: manifest.runtime.default, saveDirOverride: null,
    moduleData: { major: 8, version: '8.4.0', detectedVersion: '11.5', patched: false, assetsStaged: false }
  }));
  fixture.moduleSettings = Object.fromEntries(manifests.map(manifest => [manifest.id, manifest.settingsDefaults || {}]));
  fixture.moduleStates = Object.fromEntries(manifests.map(manifest => [manifest.id, { cheats: moduleState.cheats }]));
  fixture.runtimeManagers = {};
  for (const manifest of manifests) for (const [runtime, id] of Object.entries(manifest.runtime.manager || {})) {
    const sections = [...new Set(Object.values(manifest.runtime.managerSectionMap?.[runtime] || {}))];
    fixture.runtimeManagers[id] = {
      id, label: manifest.runtime.entries?.[runtime]?.label || id,
      sections: (sections.length ? sections : ['default']).map(sectionId => ({ ...section, id: sectionId, label: sectionId }))
    };
  }
  fixture.launcherSettings.library = {
    version: 1, sort: { mode: 'custom', direction: 'asc' },
    order: fixture.recents.map(game => game.gameId), favorites: fixture.recents.slice(1, 3).map(game => game.gameId)
  };
  return fixture;
}

module.exports = { createLibraryFixture, createEngineLibraryFixture };
