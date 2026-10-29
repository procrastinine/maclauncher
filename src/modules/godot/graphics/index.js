const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const GameData = require('../../shared/game-data');
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
    if (metadata.abi !== 1 || metadata.complete !== true || metadata.sourceCommit !== SOURCE.commit || !fs.statSync(library).isFile()) return null;
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
function prepare(entry, { target, version, userDataDir, root, platform = process.platform } = {}) {
  if (platform !== 'darwin' || !supportedVersion(version)) return null;
  // This module-owned activation bootstrap makes later camera/source selection
  // possible inside Godot. It is separate from shared frame processing: an
  // inactive bridge adds no compositor callback or viewport mutation, and an
  // unavailable helper returns before any private target is prepared.
  const installed = resolve(root);
  if (!installed) {
    if (!['fsr2', 'fsr3'].includes(entry?.graphics?.temporalMethod)) return null;
    throw new Error('Godot temporal camera support is missing from the graphics runtime.');
  }
  if (!entry?.gameId || !userDataDir || !target || !['pack', 'project'].includes(target.kind)) throw new Error('Godot graphics preparation requires a game and launch target.');
  const source = path.resolve(target.path);
  const identity = crypto.createHash('sha256').update(target.kind + '\0' + source).digest('hex').slice(0, 16);
  const directory = path.join(GameData.resolveGameModuleDir(userDataDir, entry.gameId, 'godot'), 'graphics', identity);
  fs.mkdirSync(directory, { recursive: true });
  let launchPath;
  const originalDirectory = target.kind === 'pack' ? path.dirname(source) : source;
  if (target.kind === 'pack') {
    launchPath = path.join(directory, path.basename(source));
    link(source, launchPath);
  } else {
    launchPath = path.join(directory, 'project');
    fs.mkdirSync(launchPath, { recursive: true });
    for (const item of fs.readdirSync(source, { withFileTypes: true })) {
      if (item.name === 'override.cfg' || item.name === '.godot') continue;
      link(path.join(source, item.name), path.join(launchPath, item.name));
    }
    const cache = path.join(source, '.godot');
    if (fs.existsSync(cache)) {
      const privateCache = path.join(launchPath, '.godot'); fs.mkdirSync(privateCache, { recursive: true });
      for (const item of fs.readdirSync(cache, { withFileTypes: true })) {
        if (!['imported', 'uid_cache.bin', 'global_script_class_cache.cfg', 'extension_list.cfg'].includes(item.name)) continue;
        const destination = path.join(privateCache, item.name);
        try { if (fs.lstatSync(destination).isSymbolicLink()) fs.unlinkSync(destination); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        fs.cpSync(path.join(cache, item.name), destination, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
      }
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
  const graphics = entry.graphics || {};
  const engineSpatial = installed.sourceResolutionAPI === 1 && !entry.effects &&
    (!graphics.neuralMethod || graphics.neuralMethod === 'off') && (!graphics.temporalMethod || graphics.temporalMethod === 'off') &&
    ['bilinear', 'metalfx', 'fsr1'].includes(graphics.spatialMethod) ? graphics.spatialMethod : null;
  return { target: { ...target, path: launchPath }, directory, environment: {
    MACLAUNCHER_GODOT_CAMERA_EXTENSION: extension,
    MACLAUNCHER_GODOT_CAMERA_SCRIPT: path.join(installed.directory, 'camera-effect.gd'),
    ...(installed.sceneAovAPI?{MACLAUNCHER_GODOT_AOV_SCRIPT:path.join(installed.directory,'aov-effect.gd')}:{ }),
    ...(engineSpatial ? { MACLAUNCHER_GODOT_SPATIAL_METHOD: engineSpatial } : {})
  } };
}
module.exports = { supportedVersion, resolve, prepare };
