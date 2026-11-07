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
const projectPage = (project, source) => {
  const base = new URL(normalized(project)), page = new URL(normalized(source));
  const prefix = base.pathname.replace(/\/+$/, '');
  return base.origin === page.origin && (page.pathname === prefix || page.pathname.startsWith(prefix + '/'));
};

test('every registered runtime manager has a linked upstream project in Credits', () => {
  const upstream = {
    ai5: 'https://github.com/nunuhara/ai5-sdl2',
    'apple-metal-toolchain': 'https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components',
    assetripper: 'https://github.com/AssetRipper/AssetRipper',
    'browser-woditor': 'https://frostyhowl.com/browser-woditor/',
    butterscotch: 'https://github.com/ButterscotchRunner/Butterscotch',
    crossover: 'https://www.codeweavers.com/crossover',
    dxvk: 'https://github.com/doitsujin/dxvk',
    'dxvk-nvapi': 'https://github.com/jp7677/dxvk-nvapi',
    'vkd3d-proton': 'https://github.com/metalsharp/VKD3D-Proton-MacOS',
    'maclauncher-steam-bridge': 'https://github.com/ValveSoftware/Proton',
    easyrpg: 'https://github.com/EasyRPG/Player',
    ffdec: 'https://github.com/jindrapetrik/jpexs-decompiler',
    fna: 'https://github.com/FNA-XNA/FNA',
    'flash-projector': 'https://www.adobe.com/products/flashplayer/end-of-life.html',
    'gamemaker-official': 'https://gamemaker.io/',
    'gamemaker-opengl-helper': 'https://github.com/procrastinine/maclauncher-builds',
    gemrb: 'https://github.com/gemrb/gemrb',
    'gm8-decompiler': 'https://github.com/OpenGMK/OpenGMK',
    godot: 'https://github.com/godotengine/godot',
    'graphics-neural-models': 'https://github.com/eugeniosegala/MAKO',
    'graphics-shader-library': 'https://github.com/crosire/reshade-shaders',
    'graphics-models': 'https://github.com/eugeniosegala/MAKO',
    hashlink: 'https://github.com/HaxeFoundation/hashlink',
    ikemen: 'https://github.com/ikemen-engine/Ikemen-GO',
    ilspy: 'https://github.com/icsharpcode/ILSpy',
    impacto: 'https://github.com/CommitteeOfZero/impacto',
    innoextract: 'https://github.com/dscharrer/innoextract',
    java: 'https://adoptium.net/',
    krkrsdl2: 'https://github.com/krkrsdl2/krkrsdl2',
    love: 'https://github.com/love2d/love',
    mkxpz: 'https://github.com/mkxp-z/mkxp-z',
    'graphics-xess': 'https://github.com/intel/xess',
    'vulkan-moltenvk': 'https://github.com/Sikarugir-App/MoltenVK',
    'vulkan-moltenvk-scene': 'https://github.com/KhronosGroup/MoltenVK',
    'maclauncher-crossover-winemac': 'https://www.codeweavers.com/crossover/source',
    'fidelityfx-api': 'https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK',
    'vulkan-kosmickrisp': 'https://gitlab.freedesktop.org/mesa/mesa',
    'maclauncher-kosmickrisp': 'https://gitlab.freedesktop.org/mesa/mesa',
    'alice-tools': 'https://github.com/nunuhara/alice-tools',
    'android': 'https://github.com/shinyquagsire23/Klepton',
    'macapk': 'https://github.com/kksimp/Mac.apk',
    'android-aim': 'https://github.com/hahnlee/aim',
    'jadx': 'https://github.com/skylot/jadx',
    'apktool': 'https://github.com/iBotPeaches/Apktool',
    'msg-tool': 'https://github.com/lifegpc/msg-tool',
    'dosbox-staging': 'https://github.com/dosbox-staging/dosbox-staging',
    'hlbc': 'https://github.com/Gui-Yom/hlbc',
    'playcover': 'https://github.com/PlayCover/PlayCover',
    'ljd': 'https://github.com/dol/luajit-decompiler',
    'unluac': 'https://sourceforge.net/projects/unluac/',
    'mac32': 'https://github.com/Shagulka/mac32',
    'sc3tools': 'https://github.com/CommitteeOfZero/sc3tools',
    'sff-tools': 'https://github.com/openkakutou/sff',
    'nxnative': 'https://github.com/seedds/nxnative',
    'nxnative-tools': 'https://github.com/seedds/nxnative',
    'anyps5': 'https://github.com/boykopovar/AnyPS5',
    prosper: 'https://github.com/mattias800/prosper',
    'siglus-ssu': 'https://github.com/Jirehlov/SiglusSceneScriptUtility',
    'rldev': 'https://github.com/yoremi-trad-fr/rldev2026-go-edition',
    'cpp2il': 'https://github.com/SamboyCoding/Cpp2IL',
    'mpv': 'https://mpv.io/',
    'mpv-plugins': 'https://github.com/tomasklaen/uosc',
    'uosc-helper': 'https://github.com/tomasklaen/uosc',
    'sikarugir-graphics-bridge': 'https://github.com/Sikarugir-App/Engines',
    'wolftl': 'https://github.com/Sinflower/WolfTL',
    'uberwolf': 'https://github.com/Sinflower/UberWolf',
    'native-inspector': 'https://github.com/rizinorg/cutter',
    npengine: 'https://github.com/FGRE/libnpengine',
    'near-infinity': 'https://github.com/Argent77/NearInfinity',
    reminori: 'https://github.com/luoyily/ReMinori',
    nwjs: 'https://github.com/nwjs/nw.js/',
    'vnds-love': 'https://github.com/ajusa/VNDS-LOVE',
    opengmk: 'https://github.com/OpenGMK/OpenGMK',
    'onscripter-en': 'https://github.com/Galladite27/ONScripter-EN',
    onsyuri: 'https://github.com/YuriSizuku/OnscripterYuri',
    rfvp: 'https://github.com/xmoezzz/rfvp',
    'rpgmaker-decrypter': 'https://github.com/uuksu/RPGMakerDecrypter',
    ruffle: 'https://github.com/ruffle-rs/ruffle',
    sdk: 'https://github.com/renpy/renpy',
    scummvm: 'https://www.scummvm.org/',
    'scummvm-tools': 'https://github.com/scummvm/scummvm-tools',
    siglus: 'https://github.com/xmoezzz/siglus_rs',
    sikarugir: 'https://github.com/Sikarugir-App/Engines',
    winecx: 'https://github.com/dappermint/winecx-gptk',
    rlvm: 'https://github.com/eglaysher/rlvm',
    'rlvm-adapter': 'https://github.com/eglaysher/rlvm',
    'sys3-decompiler': 'https://github.com/kichikuou/sys3c',
    system3: 'https://github.com/kichikuou/system3-sdl2',
    'undertale-mod-cli': 'https://github.com/UnderminersTeam/UndertaleModTool',
    unity: 'https://unity.com/releases/editor/archive',
    'xash3d-fwgs': 'https://github.com/FWGS/xash3d-fwgs',
    uzdoom: 'https://github.com/UZDoom/UZDoom',
    raze: 'https://github.com/ZDoom/Raze',
    dreamm: 'https://dreamm.aarongiles.com/',
    'xsys35-decompiler': 'https://github.com/kichikuou/xsys35c',
    xsystem35: 'https://github.com/kichikuou/xsystem35-sdl2',
    xsystem4: 'https://github.com/nunuhara/xsystem4'
  };
  const managers = [...registry.listSharedRuntimeManagers(), ...registry.listModules().flatMap(module => registry.getModule(module.id).runtimeManagers || [])];
  const { definitions } = require('../src/modules/shared/runtime/translator-managers');
  for (const manager of new Map(managers.map(manager => [manager.id, manager])).values()) {
    const { id } = manager;
    // Translator managers link each source they declare; another manager that
    // supplies a translator choice, such as the NGX core, links its upstream.
    if (definitions[manager.translatorEngine] && id === `translator-${manager.translatorEngine}`) {
      const catalog = manager.getState().catalog;
      const sources = [...(catalog.sources || [catalog]).flatMap(source => [source.sourceUrl,
        ...(source.variants || []).map(variant => variant.catalog.sourceUrl)]), ...(catalog.sourceLinks || []).map(source => source.url)];
      assert.ok(sources.length, `${id}: retain its declared source projects`);
      for (const url of sources) assert.ok([...allProjects].some(project => projectPage(project, url)), `${id}: Credits must link its declared source project ${url}`);
      continue;
    }
    assert.ok(upstream[id], `${id}: record its real upstream project when registering a manager`);
    assert.ok(allProjects.has(normalized(upstream[id])), `${id}: Credits must link its upstream`);
  }
  const project = 'https://example.test/group/project';
  assert.equal(projectPage(project, project + '/releases'), true);
  assert.equal(projectPage(project, project + '-other/releases'), false);
  assert.equal(projectPage(project, project + '/../other/releases'), false);
  assert.equal(projectPage(project, 'https://other.test/group/project/releases'), false);
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
    // npm reads a bare owner/name repository as a GitHub project.
    const url = repository.replace(/^git\+/, '').replace(/^git:\/\/github.com\//, 'https://github.com/').replace(/^(?:github:)?([\w.-]+\/[\w.-]+)$/, 'https://github.com/$1').replace(/\.git$/, '');
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

test('attributions retain separate component and proprietary terms', () => {
  const doc = fs.readFileSync(path.join(root, 'docs/ATTRIBUTIONS.md'), 'utf8');
  assert.match(doc, /\[FelineSystem2\][^\n]+does not play CatSystem2 games/);
  assert.match(doc, /\[Unity player components\][^\n]+\[official GameMaker runtimes\][^\n]+\[Adobe Flash Player\][^\n]+vendor terms/);
  assert.match(doc, /\[Kosugi\][^\n]+\(Apache-2\.0\)/);
});
