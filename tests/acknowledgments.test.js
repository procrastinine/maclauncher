const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const registry = require('../src/modules/registry');
const shared = require('../src/modules/shared/acknowledgments.json');
const root = path.resolve(__dirname, '..');
const normalized = url => url.trim().replace(/\/+$/, '').toLowerCase();
const projects = module => new Set((module.acknowledgments || []).map(item => normalized(item.url)));
const allProjects = new Set([...shared, ...registry.listModules().flatMap(module => module.acknowledgments || [])].map(item => normalized(item.url)));

test('every registered runtime manager has a linked upstream project in Credits', () => {
  const upstream = {
    ai5: 'https://github.com/nunuhara/ai5-sdl2',
    butterscotch: 'https://github.com/ButterscotchRunner/Butterscotch',
    fna: 'https://github.com/FNA-XNA/FNA',
    'flash-projector': 'https://www.adobe.com/products/flashplayer/end-of-life.html',
    'gamemaker-official': 'https://gamemaker.io/',
    gemrb: 'https://github.com/gemrb/gemrb',
    'gm8-decompiler': 'https://github.com/OpenGMK/OpenGMK',
    godot: 'https://github.com/godotengine/godot',
    hashlink: 'https://github.com/HaxeFoundation/hashlink',
    ikemen: 'https://github.com/ikemen-engine/Ikemen-GO',
    ilspy: 'https://github.com/icsharpcode/ILSpy',
    impacto: 'https://github.com/CommitteeOfZero/impacto',
    innoextract: 'https://github.com/dscharrer/innoextract',
    java: 'https://adoptium.net/',
    krkrsdl2: 'https://github.com/krkrsdl2/krkrsdl2',
    love: 'https://github.com/love2d/love',
    mkxpz: 'https://github.com/mkxp-z/mkxp-z',
    npengine: 'https://github.com/FGRE/libnpengine',
    reminori: 'https://github.com/luoyily/ReMinori',
    nwjs: 'https://github.com/nwjs/nw.js/',
    opengmk: 'https://github.com/OpenGMK/OpenGMK',
    'onscripter-en': 'https://github.com/Galladite27/ONScripter-EN',
    onsyuri: 'https://github.com/YuriSizuku/OnscripterYuri',
    ruffle: 'https://github.com/ruffle-rs/ruffle',
    sdk: 'https://github.com/renpy/renpy',
    siglus: 'https://github.com/xmoezzz/siglus_rs',
    rlvm: 'https://github.com/eglaysher/rlvm',
    'sys3-decompiler': 'https://github.com/kichikuou/sys3c',
    system3: 'https://github.com/kichikuou/system3-sdl2',
    'undertale-mod-cli': 'https://github.com/UnderminersTeam/UndertaleModTool',
    unity: 'https://unity.com/releases/editor/archive',
    'xsys35-decompiler': 'https://github.com/kichikuou/xsys35c',
    xsystem35: 'https://github.com/kichikuou/xsystem35-sdl2',
    xsystem4: 'https://github.com/nunuhara/xsystem4'
  };
  const managers = [...registry.listSharedRuntimeManagers(), ...registry.listModules().flatMap(module => registry.getModule(module.id).runtimeManagers || [])];
  for (const id of new Set(managers.map(manager => manager.id))) {
    assert.ok(upstream[id], `${id}: record its real upstream project when registering a manager`);
    assert.ok(allProjects.has(normalized(upstream[id])), `${id}: Credits must link its upstream`);
  }
});

test('separate backend libraries and tools retain separate project links', () => {
  const dependencies = {
    ai5: ['nunuhara/libai5', 'nunuhara/nulib'],
    alicesoft: ['nunuhara/libsys4', 'kichikuou/sys3c', 'kichikuou/xsys35c'],
    bgi: ['Cytlan/openbgi'],
    fna: ['dotnet/runtime', 'dotnet/roslyn', 'FNA-XNA/FNA3D', 'FNA-XNA/FAudio', 'icsharpcode/ILSpy'],
    gamemaker: ['UnderminersTeam/Underanalyzer', 'UnderminersTeam/UndertaleModTool', 'OpenGMK/OpenGMK'],
    kirikiri: ['krkrsdl2/kag3', 'krkrsdl2/krkrz', 'simd-everywhere/simde'],
    nitroplus: ['FGRE/libnpengine', 'FGRE/libnpa']
  };
  for (const [id, repositories] of Object.entries(dependencies)) {
    const urls = projects(registry.getModuleInfo(id));
    for (const repository of repositories) assert.ok(urls.has(normalized(`https://github.com/${repository}`)), `${id}: ${repository}`);
  }
  assert.equal(registry.getModuleInfo('gamemaker').acknowledgments.find(item => item.url === 'https://github.com/UnderminersTeam/Underanalyzer').label, 'Underanalyzer (MPL-2.0)');
  const { SOURCES } = require('../src/modules/mages/native/adapter');
  const mages = projects(registry.getModuleInfo('mages'));
  for (const source of Object.values(SOURCES)) {
    const url = source.repository || new URL(source.archive).origin;
    assert.ok(mages.has(normalized(url)), `MAGES: ${url}`);
  }
});

test('launcher packages link their installed upstream metadata without enumerating unrelated sources', () => {
  const pkg = require('../package.json');
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const metadata = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
    const repository = typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url;
    assert.ok(repository, `${name}: upstream metadata required`);
    const url = repository.replace(/^git\+/, '').replace(/^git:\/\/github.com\//, 'https://github.com/').replace(/\.git$/, '');
    assert.ok(allProjects.has(normalized(url)), `${name}: ${url}`);
  }
});

test('all Credits links also appear as links in public attributions', () => {
  const doc = fs.readFileSync(path.join(root, 'docs/ATTRIBUTIONS.md'), 'utf8');
  const linked = new Set([...doc.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)].map(match => normalized(match[1])));
  for (const url of allProjects) assert.ok(linked.has(url), `Attributions must link ${url}`);
  for (const item of [...shared, ...registry.listModules().flatMap(module => module.acknowledgments || [])]) {
    assert.ok(item.label.trim(), `Describe ${item.url}`);
    const url = new URL(item.url);
    assert.equal(url.protocol, 'https:', item.label);
    assert.equal(url.username + url.password, '', item.label);
  }
});

test('beta and proprietary attributions retain capability limits and separate terms', () => {
  const doc = fs.readFileSync(path.join(root, 'docs/ATTRIBUTIONS.md'), 'utf8');
  const impacto = doc.split('\n').find(line => line.startsWith('The Windows [Impacto]'));
  assert.match(impacto, /native title\/main-menu beta/);
  assert.match(impacto, /story progression, auxiliary menus and saves[^.]+outside[^.]+supported[^.]+scope/);
  assert.match(doc, /Mac \[OpenGMK\][^\n]+runner beta/);
  assert.match(doc, /\[FelineSystem2\][^\n]+no core license/);
  assert.match(doc, /\[Unity player components\][^\n]+\[official GameMaker runtimes\][^\n]+\[Adobe Flash Player\][^\n]+vendor terms/);
  assert.match(doc, /\[Kosugi\][^\n]+\(Apache-2\.0\)/);
});

const ai5Root = path.join(root, 'src/resources/native-runtimes/ai5');
test('available AI5 bundle Kosugi declarations match their preserved Apache license', { skip: !fs.existsSync(ai5Root) }, () => {
  for (const version of ['1.5.0-macos-v1', '1.5.0-macos-v2']) {
    const directory = path.join(ai5Root, version, 'arm64');
    if (!fs.existsSync(directory)) continue;
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    const notice = manifest.notices.find(item => item.name === 'Kosugi-Regular');
    assert.equal(notice?.license, 'Apache-2.0', version);
    assert.match(fs.readFileSync(path.join(directory, 'files', notice.path), 'utf8'), /Apache License[\s\S]+Version 2\.0/);
  }
});
