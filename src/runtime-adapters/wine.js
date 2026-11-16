'use strict';
const fs = require('node:fs'), path = require('node:path');

function createLog(directory) {
  const file = path.join(directory, "wine.log");
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o600);
  let bytes = 0, closed = false;
  const write = chunk => {
    if (closed) return;
    const size = Math.min(chunk.length, 512 * 1024 - bytes);
    if (size > 0) {
      try { fs.writeSync(fd, chunk, 0, size); bytes += size; }
      catch { close(); }
    }
  };
  const close = () => { if (!closed) { closed = true; try { fs.closeSync(fd); } catch {} } };
  return { close, attach: child => {
    child.stdout?.on("data", write); child.stderr?.on("data", write);
    child.once("close", close); child.once("error", close);
    if (child.exitCode != null || child.signalCode != null) close();
  } };
}
async function launch(plan, context, {processes = require('../modules/shared/runtime/wine-processes'), activation = require('../modules/shared/runtime/wine-activation'), supervisorArguments, createLog: logFactory = createLog} = {}) {
  const log = logFactory(plan.directory);
  try {
    processes.installStopHandler(context, plan);
    const args = plan.existingEnvironment ? processes.externalArguments(plan.winePath, plan.args, plan.environment, plan.sessionPath) :
      supervisorArguments(plan.winePath, plan.serverPath, 'play', plan.args, plan.environment, plan.sessionPath);
    const child = await context.spawnDetachedChecked('/bin/sh', args,
      {cwd: plan.workingDirectory || path.dirname(plan.executablePath), env: plan.environment, stdio: ['ignore','pipe','pipe'], graphicsExecutable: plan.winePath}, false);
    log.attach(child);
    activation.followWineActivation(child, context);
    return child;
  } catch (error) { log.close(); throw error; }
}

// Selection and process architecture have already been resolved by core.
function apply({environment = {}}) { return {environment: {...environment}}; }
function definition(id) {
  const value = require('../runtime-sources').loadSources().find(source => source.kind === 'wine' && source.id === id);
  if (!value) throw new Error('Unknown Wine source: ' + id);
  return value;
}
function descriptor(id, transport) {
  const data = definition(id), wine = data.wine || {};
  return Object.freeze({...wine, id: data.id, label: data.label, runtimeLabel: data.label, managerId: data.manager?.id || data.id,
    order: data.order, labels: Object.freeze({...data.labels}), source: data,
    vulkanLibrarySelector: typeof wine.vulkanLibrarySelector === 'boolean' ? () => wine.vulkanLibrarySelector : install => install?.capabilities?.vulkanLibrarySelector === true,
    ...transport,
    nativeLibraries(install) { return nativeLibraries(data,install); },
    includedTranslators(install, add, context) { return includedTranslators(data, install, add, context); }});
}
function installationRoot(source, install) {
  if (install.installDir || install.appPath) return install.installDir || install.appPath;
  let root = install.executablePath;
  const segments = source.layout.entry.split('/');
  if (!root) {
    root = install.engineRoot || install.wineRoot || install.crossoverRoot;
    if (!root) return install.librariesRoot || (() => {throw new Error('Wine installation has no recorded root.');})();
    segments.splice(-2);
  }
  for (const _part of segments) root = path.dirname(root);
  return root;
}
function resolvePart(source, install, part) {
  if (install.templateRoot && part.path.startsWith('support/')) return path.join(install.templateRoot,part.path.slice('support/'.length));
  const wineRelative=path.posix.dirname(path.posix.dirname(source.layout.entry));
  if (install.libraryRoot && part.path.startsWith(wineRelative+'/lib/')) return path.join(install.libraryRoot,part.path.slice((wineRelative+'/lib/').length));
  if (install.librariesRoot && part.path.startsWith(path.posix.dirname(wineRelative)+'/')) return path.join(install.librariesRoot,part.path.slice((path.posix.dirname(wineRelative)+'/').length));
  if (install.crossoverRoot && part.path.startsWith(wineRelative+'/')) return path.join(install.crossoverRoot,part.path.slice((wineRelative+'/').length));
  return path.join(installationRoot(source,install),part.path);
}
// Canonical parent inventory projection. Callers inspect these paths and take
// the maximum measured floor; this helper returns source-declared facts only.
function embeddedComponent(install, {sourceId, engine}) {
  const source=definition(sourceId), embed=source.embeds.find(embed=>embed.engine===engine);
  if (!embed) return null;
  const parts=embed.parts.map(part=>({...part,path:resolvePart(source,install,part)}));
  const floors=(embed.interfaces?.requires || []).filter(token=>token.startsWith('macos>=')).map(token=>token.slice(7));
  return {source,embed,root:parts[0]?.path,parts,interfaces:embed.interfaces || {},
    minimumMacOS:floors.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1) || null};
}
function nativeLibraries(source, install) {
  const media=source.embeds.find(embed=>embed.kind==='media'), driver=source.embeds.find(embed=>embed.kind==='vulkan-driver');
  const parts=Object.fromEntries(media.parts.map(part=>[part.name,resolvePart(source,install,part)]));
  const library=path.dirname(resolvePart(source,install,driver.parts[0]));
  const lib=path.dirname(parts.core), framework=parts.framework && path.dirname(parts.framework);
  return {libraries:[library],frameworks:framework?[framework]:[],
    gstreamer:fs.existsSync(framework?lib:parts.plugins)?{lib,plugins:parts.plugins,...(parts.scanner?{scanner:parts.scanner}:{})}:null};
}
function includedTranslators(source, install, add, context = {}) {
  const root = installationRoot(source, install), warnings = context.warnings || [];
  const resolve = part => resolvePart(source,install,part);
  for (const embed of source.embeds || []) {
    if (embed.engine === 'wined3d' || context.requestedEngine && context.requestedEngine !== embed.engine) continue;
    const parts = Object.fromEntries(embed.parts.map(part => [part.name || 'component', resolve(part)]));
    let primary = embed.kind === 'media' ? parts.plugins : resolve(embed.parts[0]);
    if (embed.kind === 'vulkan-driver' && parts.icd && fs.existsSync(parts.icd)) {
      try { primary=path.resolve(path.dirname(parts.icd),JSON.parse(fs.readFileSync(parts.icd,'utf8')).ICD.library_path); }
      catch(error){warnings.push(error.message);continue;}
    }
    if (!primary || !fs.existsSync(primary)) continue;
    if (embed.kind === 'media') {
      const extra = {form: 'dylib', ...(parts.core && fs.existsSync(parts.core) ? {version: context.gstreamerVersion?.(parts.core)} : {}),
        ...(parts.framework ? {frameworkRoot: path.join(parts.framework,'Versions/1.0')} : {})};
      add(primary, embed.engine, 'video', extra);
      if (parts.framework && context.nativeRoots) context.nativeRoots.push(path.dirname(parts.core));
    } else if (embed.kind === 'vulkan-driver') {
      const extra = {form: parts.icd && fs.existsSync(parts.icd) ? 'icd' : 'dylib'};
      const before = context.result?.length || 0;
      add(primary, embed.engine, 'vulkan-driver', extra);
      if (context.result?.length > before && parts.icd && fs.existsSync(parts.icd)) {
        const description = context.result.at(-1); description.icd = parts.icd;
        if (parts.loader && fs.existsSync(parts.loader)) {
          try {
            const relative = path.relative(root, parts.loader);
            const file = context.describe ? context.describe(parts.loader, {engine: embed.engine, component:'vulkan-driver', source: context.source, form:'dylib'})?.files[0]
              : context.Description.inspectFile({path:parts.loader,relative});
            if (file) description.files.push({...file,relative});
          } catch (error) { warnings.push(error.message); }
        }
      }
    } else {
      const semantic = embed.parts[0].name;
      const versions = install.componentVersions || {};
      add(primary, embed.engine, 'd3d-renderer', {...(versions[embed.engine] ? {version:versions[embed.engine]} : {}),
        ...(source.wine?.directDraw ? {templateComponent:semantic,hiddenChoice:embed.engine==='cnc_ddraw'} : {})});
    }
  }
}

function supportFacts(id) {
  const source=definition(id), embeds=source.embeds || [];
  const renderers=embeds.filter(embed=>embed.kind==='d3d-translator' && embed.engine!=='wined3d');
  const rendererPath=path.posix.dirname(renderers[0].parts[0].path), support=rendererPath.split('/')[0];
  const relative=value=>path.posix.relative(support,value);
  const icd=embeds.find(embed=>embed.kind==='vulkan-driver')?.parts.find(part=>part.name==='icd');
  const media=embeds.find(embed=>embed.kind==='media');
  return {root:support, relativePaths:{frameworks:relative(path.posix.dirname(rendererPath)),renderers:relative(rendererPath),vulkan:relative(path.posix.dirname(icd.path))},
    media:Object.fromEntries(media.parts.map(part=>[part.name,relative(part.path)])),
    minimumMacOS:Object.fromEntries(embeds.flatMap(embed=>{const floors=(embed.interfaces?.requires||[]).filter(value=>value.startsWith('macos>=')).map(value=>value.slice(7));return floors.length?[[embed.engine,[...floors.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1).split('.'),'0','0'].slice(0,3).join('.')]]:[];}))};
}
// One storage/status path for managed Wine sources. Publisher modules supply
// only release recognition, extraction and sealed payload transport hooks.
function createBackend({source, dependencies = {}}) {
  if (dependencies.backend) return dependencies.backend;
  const Catalog = dependencies.catalog, Payload = dependencies.payload;
  if (!Catalog || !Payload) throw new Error('Wine transport requires catalog and payload hooks.');
  const {createPinnedNativeManager} = require('../modules/shared/runtime/pinned-native-manager');
  const Shared = require('../modules/crossover/sources/wine-payload');
  const label = source.label, id = source.manager?.id || source.id;
  const base = createPinnedNativeManager({id, label, sourceUrl: Catalog.SOURCE_URL, sourceName: source.labels?.source,
    formatVersionLabel: Catalog.versionLabel, discoverCatalog: dependencies.discoverCatalog || Catalog.discover,
    resolveExecutable: root => path.join(root, source.layout.entry),
    prepareInstall: options => Payload.preparePayload(options, dependencies),
    ...(dependencies.verifyArtifact ? {verifyArtifact: dependencies.verifyArtifact} : {}),
    ...(dependencies.customRuntime === false ? {customRuntime:false} : {}), dependencies});
  const inspect = Payload.createPayloadResolver(dependencies);
  const resolvePayload = (install, options) => {
    if (install && Payload.validateInstallIdentity) {
      const reason = Payload.validateInstallIdentity(install, base.core.catalog.find(pin => pin.version === install.version));
      if (reason) return {install:null,reason};
    }
    return inspect(install, options);
  };
  const progress = (pin, onProgress) => Payload.progress ? Payload.progress(pin,onProgress) : onProgress;
  const artifacts = pin => Catalog.artifacts ? Catalog.artifacts(pin) : [pin.asset];
  const planned = selection => {
    const pin = base.core.catalog.find(pin => pin.version === selection.version);
    if (!pin) return selection;
    return {...selection, versionLabel:Catalog.versionLabel(pin,selection.install), engineVersion:pin.engineVersion,
      downloadBytes:pin.downloadBytes,artifacts:artifacts(pin),installOptions:{sectionId:'default'},
      detail:Payload.installDetail ? Payload.installDetail(pin,selection) : selection.detail};
  };
  async function selectedPin(options) {
    const settings = options.settings?.runtimes ? options.settings : {runtimes:{[id]:options.settings}};
    const choose = () => {
      base.core.listCatalog({userDataDir:options.userDataDir});
      const selection=base.resolveSelection({},settings,options.userDataDir,{version:options.version}),version=selection.preferredVersion||selection.version;
      return {version,pin:base.core.catalog.find(pin=>pin.version===version)};
    };
    let choice=choose();
    if (!Catalog.validateEntry(choice.pin)) {await base.refreshCatalog({userDataDir:options.userDataDir,signal:options.signal,logger:options.logger,force:true});choice=choose();}
    if (!Catalog.validateEntry(choice.pin)) throw new Error(`No ${label} download is listed for this selection. Select an available version in Runtimes or the game settings.`);
    await Catalog.prepareSelection?.(choice.pin,options,dependencies);
    return choice;
  }
  const manager={...base,ui:{...source.manager,groupId:source.kind,management:'managed',order:source.order},upstream:Catalog.sources || (Catalog.source?[Catalog.source]:[]),
    resolveSelection:require('../modules/crossover/sources/wine-selection').createSelection({base,resolvePayload,planned}),
    preparePayloads:options=>Shared.prepareInstalled(base.core,inspect.prepare,options),
    async resolveForPlay(entry,context) {require('../modules/shared/runtime/download-utils').throwIfAborted(context.signal);return manager.resolveSelection(entry,context.settings,context.userDataDir,{signal:context.signal});},
    async prepareLocalState(options={}) {
      const Translators=require('../modules/shared/runtime/wine-translators');
      for(const row of base.core.listInstalled(options.userDataDir)){const resolved=row.ready===false?null:resolvePayload(row,{verification:'status'});if(resolved?.install)await Translators.describedIncluded(resolved.install,source.id,options);}
    },
    getState(options={}) {
      const state=base.getState(options),requirements={...state.catalog.versionRequirements};
      const installed=state.installed.map(row=>{
        if(row.ready===false)return row;
        const result=resolvePayload(row,{verification:'status'});
        requirements[row.version]={...requirements[row.version],available:Boolean(result.install),...(result.minimumMacOS?{minimumMacOS:result.minimumMacOS,...(result.install?{}:{installReason:result.reason})}:{})};
        if(!result.install)return {...row,ready:false,status:result.minimumMacOS?'unsupported-host':'damaged',error:result.reason};
        const componentSummary=options.componentSummaries===false?'':require('../modules/shared/runtime/wine-translators').includedSummary(result.install,source.id,options);
        return {...result.install,versionLabel:Catalog.versionLabel(row.catalogEntry,result.install),ready:true,status:'ready',...(componentSummary?{componentSummary}:{})};
      });
      Catalog.describeRequirements?.(base.core.catalog,requirements,installed,options,dependencies);
      const catalog={...state.catalog,delivery:'download',importable:false,versionRequirements:requirements,
        installableVersions:state.catalog.installableVersions.filter(version=>!requirements[version]?.installReason),latestInstalledVersion:installed.find(row=>row.ready)?.version||null,
        installReason:state.catalog.installable||installed.some(row=>row.ready)?null:state.catalog.status==='success'?`No compatible ${label} downloads are currently available.`:`Reload versions to select a ${label} download. Play also prepares the required version automatically.`};
      catalog.installable=catalog.installableVersions.length>0;
      const output={...state,installed,catalog};return {...output,sections:[{...state.sections[0],...output,sections:undefined}]};
    },
    async installRuntime(options) {return install(options,(opts)=>base.installRuntime(opts));},
    core:{...base.core,get catalog(){return base.core.catalog;},resolveInstalled:options=>resolvePayload(base.core.resolveInstalled(options),options).install,
      resolveRegistered:options=>resolvePayload(base.core.resolveRegistered(options),options).install,
      listInstalled:userDataDir=>base.core.listInstalled(userDataDir).map(row=>resolvePayload(row)).map(value=>value.install).filter(Boolean),
      async installVersion(options){return install(options,opts=>base.core.installVersion(opts));}}
  };
  async function install(options, perform) {
    const {version,pin}=await selectedPin(options),existing=base.core.resolveInstalled({userDataDir:options.userDataDir,version});
    const downloads=typeof options.downloads?.runTask==='function'?{runTask:(meta,runner)=>options.downloads.runTask({...meta,detail:pin.versionLabel},task=>runner({...task,onProgress:progress(pin,task.onProgress)}))}:options.downloads;
    const result=resolvePayload(await perform({...options,version,downloads,replace:Boolean(existing&&!resolvePayload(existing,{signal:options.signal}).install),onProgress:progress(pin,options.onProgress)}),{signal:options.signal});
    if(!result.install)throw new Error(result.reason);return result.install;
  }
  Payload.configureCustom?.(manager,inspect,dependencies);
  return manager;
}
function listBuilds({manager,sources,context={}}) {
  if (context.builds) {
    const sourceIds=new Set(sources.flatMap(source=>[source.id,...(source.embeds || []).map(embed=>embed.id)]));
    return context.builds.filter(build=>sourceIds.has(build.source));
  }
  const builds=[];
  for (const source of sources) {
    const installed=manager.core.listInstalled(context.userDataDir);
    for (const row of installed) {
      const root=row.installDir || row.appPath;
      const executable=row.graphicsExecutablePath || row.executablePath;
      const architectures=row.architectures || [];
      const binaries=executable && root && architectures.length ? [{path:path.relative(root,executable),format:'macho',architectures:[...architectures]}] : [];
      builds.push({id:source.id+':'+row.version,source:source.id,kind:'wine',version:row.version,installed:true,measured:binaries.length>0,binaries,
        root,label:row.versionLabel || source.label,order:source.order,parts:{executable,server:row.serverPath},
        interfaces:{provides:source.interfaces?.provides || [],requires:[...(source.interfaces?.requires || []),...(row.minimumMacOS?['macos>='+row.minimumMacOS]:[])]},
        ...(source.selector?{selector:source.selector}:{}),...(source.automatic?{automatic:source.automatic}:{}),labels:source.labels,
        ...(row.ready===false?{available:false,unavailableReason:row.reason || row.error || 'Wine installation is unavailable.'}:{}),
        aliases:[row.version],provenance:{reader:'existing Wine installation metadata',archiveSha256:row.archiveSha256}});
    }
    const pins=manager.core.listDiscoveredCatalog?.({userDataDir:context.userDataDir}) || [];
    for (const pin of pins) {
      if (installed.some(row=>row.version===pin.version)) continue;
      const asset=source.assets?.find(asset=>new RegExp(asset.match,'i').test(pin.asset?.filename || ''));
      if (!asset) continue;
      builds.push({id:source.id+':'+pin.version,source:source.id,kind:'wine',version:pin.version,installed:false,measured:false,
        binaries:[{path:source.layout.entry,format:'macho',architectures:[...asset.declares.macho]}],label:pin.versionLabel || source.label,
        order:source.order,interfaces:asset.interfaces || source.interfaces || {},bytes:pin.downloadBytes || pin.asset.bytes,
        ...(pin.installReason?{available:false,unavailableReason:pin.installReason}:{}),aliases:[pin.version]});
    }
  }
  return builds;
}

module.exports = {apply, launch, createLog, definition, descriptor, includedTranslators, installationRoot, resolvePart, embeddedComponent, nativeLibraries, supportFacts, createBackend, listBuilds};
