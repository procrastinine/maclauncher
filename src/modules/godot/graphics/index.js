const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const GameData = require('../../shared/game-data');
const ExecutionRequirements = require('../../shared/effects/execution-requirements');
const SceneDemand = require('../../shared/effects/scene-demand');
const SOURCE = require('./source.json');
const SCENE_AOVS = Object.freeze(['normal','roughness','resolvedRadiance','resolvedSpecular','metallic']);

function supportedVersion(version) {
  const parts = /^(\d+)\.(\d+)/.exec(String(version || ''));
  return Boolean(parts && Number(parts[1]) === 4 && Number(parts[2]) >= 4);
}
function resolve(root) {
  try {
    const directory = path.join(root, 'godot');
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'provider.json'), 'utf8'));
    const library = path.join(directory, 'libmaclauncher-godot-camera.dylib');
    if (metadata.abi !== 1 || metadata.complete !== true || !fs.statSync(library).isFile()) return null;
    for (const script of ['autoload.gd', 'camera-effect.gd']) if (!fs.statSync(path.join(directory, script)).isFile()) return null;
    let sourceResolutionLiveAPI = 0;
    if (metadata.sourceResolutionAPI === 1 && metadata.sourceResolutionLiveAPI === 1) {
      const script = fs.readFileSync(path.join(directory, 'autoload.gd'));
      if (metadata.ownedSourceSha256?.['autoload.gd'] === crypto.createHash('sha256').update(script).digest('hex') &&
          script.toString('utf8').includes('const SOURCE_CONTROL_API := 1\n')) sourceResolutionLiveAPI = 1;
    }
    const sceneScripts=['autoload.gd','camera-effect.gd'].every(name=>metadata.ownedSourceSha256?.[name]===crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,name))).digest('hex'));
    const sceneDemandAPI=metadata.sceneDemandAPI===1&&sceneScripts?1:0;
    const sceneDestinationAPI=sceneDemandAPI&&metadata.sceneDestinationAPI===1?1:0;
    let sceneAovAPI=0;
    if(sceneDemandAPI&&metadata.sceneAovAPI===1)try{
      const aovFile=path.join(directory,'aov-effect.gd');
      const programs=metadata.aovCapture?.programs;
      const capture=metadata.sceneCopyBoundaryAPI===1&&metadata.aovCapture?.version===1&&Array.isArray(programs)&&programs.length===4&&new Set(programs.map(row=>row.variant)).size===4&&programs.every(row=>Number.isInteger(row.variant)&&row.variant>=0&&row.variant<4&&row.file===`aov-capture-${row.variant}.spv`&&Number.isSafeInteger(row.size)&&row.size>=20&&row.size<=1024*1024&&/^[a-f0-9]{64}$/.test(row.sha256||'')&&fs.lstatSync(path.join(directory,row.file)).isFile()&&fs.statSync(path.join(directory,row.file)).size===row.size&&crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,row.file))).digest('hex')===row.sha256);
      if(capture&&fs.lstatSync(aovFile).isFile()&&metadata.ownedSourceSha256?.['aov-effect.gd']===crypto.createHash('sha256').update(fs.readFileSync(aovFile)).digest('hex'))sceneAovAPI=1;
    }catch{}
    return { library, directory, minimumGodot: '4.4', sourceResolutionAPI: metadata.sourceResolutionAPI === 1 ? 1 : 0, sourceResolutionLiveAPI,
      sceneDemandAPI,sceneDestinationAPI,sceneAovAPI,...(sceneAovAPI?{sceneCopyBoundaryAPI:1,sceneAovs:[...SCENE_AOVS],noisyColor:false}:{}) };
  } catch { return null; }
}
function link(source, target) {
  try {
    const current = fs.lstatSync(target);
    if (current.isSymbolicLink() && fs.readlinkSync(target) === source) return;
    throw new Error('Godot graphics preparation found an unrelated file.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.symlinkSync(source, target);
  }
}
function write(file, text) {
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
}
// The helper serves only a plan that consumes what the running Godot renderer
// alone supplies: scene inputs for an enabled row, or a changed 3D render size.
// Both Godot runtimes present through the shared window adapter.
function needed(entry, { userDataDir, root } = {}) {
  return ExecutionRequirements.analyze(entry).needed.sourceResolution ||
    SceneDemand.sceneDemand(entry, { userDataDir }, { root, graphicsHost: 'window' }).length > 0;
}
function prepare(entry, { target, version, userDataDir, root, platform = process.platform } = {}) {
  // A launch whose plan does not need the helper uses the original project or
  // pack, with no private override, link or cache. Godot reads override.cfg
  // only beside the project or main pack, so the autoload needs this location.
  if (platform !== 'darwin' || !supportedVersion(version) || !needed(entry, { userDataDir, root })) return null;
  const installed = resolve(root);
  if (!installed) throw new Error('The Godot camera helper is missing from the graphics runtime.');
  if (!entry?.gameId || !userDataDir || !target || !['pack', 'project'].includes(target.kind)) throw new Error('Godot graphics preparation requires a game and launch target.');
  const source = path.resolve(target.path);
  const identity = crypto.createHash('sha256').update(target.kind + '\0' + source).digest('hex').slice(0, 16);
  const directory = path.join(GameData.resolveGameModuleDir(userDataDir, entry.gameId, 'godot'), 'camera', identity);
  fs.mkdirSync(directory, { recursive: true });
  let launchPath;
  const originalDirectory = target.kind === 'pack' ? path.dirname(source) : source;
  if (target.kind === 'pack') {
    launchPath = path.join(directory, path.basename(source));
    link(source, launchPath);
  } else {
    // Every project entry, the .godot import cache included, is the original;
    // reads and writes reach the same files as a direct launch.
    launchPath = path.join(directory, 'project');
    fs.mkdirSync(launchPath, { recursive: true });
    for (const item of fs.readdirSync(source, { withFileTypes: true })) {
      if (item.name !== 'override.cfg') link(path.join(source, item.name), path.join(launchPath, item.name));
    }
  }
  let original = '';
  try { original = fs.readFileSync(path.join(originalDirectory, 'override.cfg'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const autoload = path.join(installed.directory, 'autoload.gd');
  const key = 'MacLauncherTemporalCamera_' + identity;
  const override = original + '\n[autoload]\n' + key + '=' + JSON.stringify('*' + autoload) + '\n';
  write(path.join(target.kind === 'pack' ? directory : launchPath, 'override.cfg'), override);
  const extension = path.join(directory, 'camera.gdextension');
  write(extension, '[configuration]\nentry_symbol="maclauncher_godot_camera_init"\ncompatibility_minimum="4.4"\nreloadable=false\n\n[libraries]\nmacos=' + JSON.stringify(installed.library) + '\n');
  return { target: { ...target, path: launchPath }, directory, environment: {
    MACLAUNCHER_GODOT_CAMERA_EXTENSION: extension,
    MACLAUNCHER_GODOT_CAMERA_SCRIPT: path.join(installed.directory, 'camera-effect.gd'),
    ...(installed.sceneAovAPI?{MACLAUNCHER_GODOT_AOV_SCRIPT:path.join(installed.directory,'aov-effect.gd')}:{ })
  } };
}
module.exports = { supportedVersion, resolve, prepare };
