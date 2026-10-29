const fs = require('node:fs');
const path = require('node:path');
const { createPinnedNativeManager } = require('../../shared/runtime/pinned-native-manager');
const Native = require('../../shared/runtime/local-native');
const { DEFAULT_ENTRY, DEFAULT_VERSION, SOURCE_URL, createDiscovery } = require('./catalog');
const { extractDmg } = require('./dmg');
const Signing = require('./signing');

function createManager({ discoverCatalog = createDiscovery(), dependencies = {} } = {}) {
  const verify = Signing.createVerifier();
  const base = createPinnedNativeManager({ id:'scummvm',label:'ScummVM',sourceUrl:SOURCE_URL,catalog:[DEFAULT_ENTRY],discoverCatalog,resolveExecutable:root=>path.join(root,'ScummVM.app'),
    prepareInstall:options=>Signing.prepareInstall(options),
    inspectRuntime(options) {
      const native = Native.resolveLocalRuntime(options), app = Signing.appRoot(native.executablePath);
      if (app) {
        const recordPath = path.join(path.dirname(app),'runtime.json');
        if (fs.existsSync(recordPath)) {
          const record = JSON.parse(fs.readFileSync(recordPath,'utf8'));
          verify({...record,...native});
        }
      }
      return native;
    },
    dependencies:{extractArchive:extractDmg,...dependencies} });
  function checked(install, options) {
    if (!install) return null;
    try { return verify(install,options); } catch { return null; }
  }
  const manager = { ...base,
    async prepareForGraphics(selection, context) {
      if (!selection?.ready || selection.install.source !== 'download' || selection.install.installationMetadata?.signing?.policy === Signing.POLICY) return selection;
      const version = selection.version;
      const identity = {managerId:'scummvm',version,sourcePath:selection.install.installDir};
      const mutate = context.withRuntimeMutation
        ? operation => context.withRuntimeMutation(identity,operation)
        : operation => require('../../../core/coordinated-runtime-managers').withRuntimeMutation(identity,operation,{userDataDir:context.userDataDir});
      return mutate(async () => {
        const exact = {runtimeData:{scummvm:{version}}};
        const current = manager.resolveSelection(exact,context.settings,context.userDataDir);
        if (!current.ready) throw new Error(current.reason);
        if (current.install.installationMetadata?.signing?.policy === Signing.POLICY) return current;
        const install = await Signing.repairLegacyInstallation(current.install,{signal:context.signal,
          pin:base.core.catalog.find(pin=>pin.version===version),
          prepare:options=>Signing.prepareInstall(options),
          resolveInstalled:()=>{
            base.core.clearDisplayCache(context.userDataDir);
            return manager.core.resolveInstalled({userDataDir:context.userDataDir,version});
          }});
        context.onRuntimeStateChange?.();
        return {...current,install,ready:true};
      });
    },
    resolveSelection(entry,settings,userDataDir,options={}) {
      const selection = base.resolveSelection(entry,settings,userDataDir,options);
      if (!selection.install || checked(selection.install,options)) return selection;
      return {...selection,install:null,ready:false,requiresDownload:true,reason:'The installed ScummVM files changed. Install the selected version again.'};
    },
    getState(options={}) {
      const state = base.getState(options);
      const installed = state.installed.map(row => row.ready && !checked(row,{verification:'status'})
        ? {...row,ready:false,status:'damaged',error:'The installed ScummVM files changed. Install the selected version again.'}
        : {...row,graphicsInjectionReady:row.installationMetadata?.signing?.policy===Signing.POLICY});
      const catalog = {...state.catalog,versionRequirements:Object.fromEntries(Object.entries(state.catalog.versionRequirements).map(([version,requirement])=>
        [version,{...requirement,available:installed.some(row=>row.version===version && row.ready)}]))};
      return {...state,installed,catalog,sections:state.sections.map(section=>({...section,installed,catalog}))};
    },
    core:{...base.core,
      get catalog(){return base.core.catalog;},
      resolveInstalled:options=>checked(base.core.resolveInstalled(options),options),
      resolveRegistered:options=>checked(base.core.resolveRegistered(options),options),
      listInstalled:userDataDir=>base.core.listInstalled(userDataDir).map(install=>checked(install)).filter(Boolean) }
  };
  return manager;
}
module.exports = Object.assign(createManager(),{createManager});
