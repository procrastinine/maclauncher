'use strict';
const fs=require('node:fs'),path=require('node:path');
const Plan=require('./translator-plan');
const Description=require('../../modules/shared/runtime/translator-description');
const Binary=require('../../modules/shared/runtime/binary-compatibility');
const {systemVersionSync}=require('../../modules/shared/runtime/bundled-native');
const warn=require('../../modules/shared/graphics-warning');
const Architecture=require('../../modules/shared/runtime/architecture');
const Roles=require('../../modules/shared/runtime/translator-roles');
const Requirements=require('../../modules/shared/runtime/feature-requirements');
const {compareRuntimeVersions}=require('../../modules/shared/runtime/pinned-native-manager');

function createWineResolver({optionsInventory,sourceFor}) {
// An installed managed Vulkan driver of one package that this Wine process can
// load, preferring the package's default version.
function managedDriver(input, compatibility, context, managerId) {
  const rows = input.choices.filter(item => item.component === 'vulkan-driver' && item.managerId === managerId && compatibility[item.id]?.compatible !== false);
  const preferred = require('../../modules/shared/runtime/custom-runtime').defaultVersion(context.settings, managerId);
  return rows.find(item => item.runtimeVersion === preferred) || rows.sort((a, b) => compareRuntimeVersions(a.runtimeVersion, b.runtimeVersion))[0] || null;
}
// KosmicKrisp needs Metal 4 and a physical Apple GPU. Its x64 build serves an
// x86_64 Wine process under Rosetta.
async function kosmicKrispHost(host = {}, context = {}) {
  const capabilities = { ...require('../../modules/shared/runtime/host-capabilities').getHostCapabilities(), ...host };
  if (Requirements.requirementSupport(Requirements.METAL4, capabilities).supported !== true) return null;
  const hardware = await require('../../modules/shared/runtime/graphics-hardware').graphicsHardware(capabilities, { signal: context.signal });
  return hardware.physicalAppleGPU === true ? { ...capabilities, physicalAppleGPU: true } : null;
}
// MacLauncher's own DXVK and vkd3d-proton builds, as opposed to a runtime's.
const ownVulkanTranslator = item => !item.included && !item.reference && Boolean(item.managerId) && ['dxvk', 'vkd3d-proton'].includes(item.engine);
// DXVK 2.0 and later need geometry shaders and robustness2 null descriptors,
// and vkd3d-proton also needs transform feedback; MoltenVK and its scene build
// have none of these. DXVK 1.x, such as DXVK-macOS, creates its device there.
function needsKosmicKrisp(item) {
  if (item.engine === 'vkd3d-proton') return true;
  const major = /(\d+)\.\d+/.exec(String(item.runtimeVersion || item.version || ''))?.[1];
  return item.engine === 'dxvk' && major !== undefined && Number(major) >= 2;
}
// A declined MacLauncher KosmicKrisp download for this Play (runtime-preparation `declines`).
const KOSMICKRISP_DECLINED = 'kosmickrisp-pairing';
// The downloads of the current plan's paired Vulkan driver (resolve): the
// MacLauncher KosmicKrisp build, and MacLauncher's MoltenVK scene build where
// KosmicKrisp cannot run or, for DXVK alone, when its download is declined.
async function driverRequirements(context, { host = {} } = {}) {
  const pending = context.translatorPlan?.vulkanPending;
  if (!pending) return [];
  const Managed = require('../../modules/shared/vulkan/managed');
  let carrier = null;
  if (pending.carrier) {
    const selected = Managed.sceneManager.resolveSelection(null, context.settings, context.userDataDir, { verification: 'status' });
    if (!selected.ready && (selected.version || selected.discoveryRequired)) carrier = { managerId: Managed.sceneProjectId, version: selected.version || null,
      ...(selected.discoveryRequired ? { discoveryRequired: true } : {}), requiresDownload: true, installOptions: { sectionId: 'default' },
      detail: 'Installs the MoltenVK build that forwards DLSS frames from MacLauncher\'s DXVK and vkd3d-proton.' };
  }
  const capabilities = pending.kosmicKrisp && pending.architecture && await kosmicKrispHost(host, context);
  const offer = capabilities && require('../../modules/shared/vulkan').kosmicKrispOffer(context, { architecture: pending.architecture, managers: [], hostCapabilities: capabilities });
  if (!offer) return carrier ? [carrier] : [];
  // vkd3d-proton does not start on MoltenVK, so its pairing needs KosmicKrisp.
  if (pending.vkd3d) {
    const { optional, cancelLabel, ...required } = offer;
    return [{ ...required, detail: 'MacLauncher\'s vkd3d-proton runs on KosmicKrisp, which also forwards DLSS frames.' }];
  }
  // DXVK 2.0 and later do not start on MoltenVK: skipping keeps the runtime's
  // own automatic Direct3D choice and Vulkan driver for this Play.
  if (pending.moltenVK === false) {
    const automatic = Plan.sourceLabels(context.runtimeId || context.translatorPlan?.runtime).automatic;
    return [{ ...offer, cancelLabel: 'Use ' + automatic.replace(/\b(automatic|choice)\b/g, word => word[0].toUpperCase() + word.slice(1)),
      declines: [KOSMICKRISP_DECLINED], detail: `MacLauncher's DXVK runs on KosmicKrisp, which also forwards DLSS frames. Skipping uses ${automatic} instead of MacLauncher's DXVK.` }];
  }
  return [{ ...offer, detail: 'MacLauncher\'s DXVK runs on KosmicKrisp, which also forwards DLSS frames. Skipping uses MacLauncher\'s MoltenVK build.',
    ...(carrier ? { fallback: carrier } : {}) }];
}
async function resolve(install, runtime, context, { executableArchitecture, host = {}, ...dependencies } = {}) {
  const input = await optionsInventory(install, runtime, context, dependencies);
  // Display records omit native symbols. Play completes those facts before
  // checking Wine imports; video completes its own selected plugin closure.
  const complete = item => item.component === 'video' ? item : { ...item, files: item.files.map(file =>
    file.format === 'macho' && file.slices?.some(slice => slice.importsComplete !== true) && fs.existsSync(file.path)
      ? Description.inspectFile(file) : file) };
  input.included = input.included.map(complete); input.choices = input.choices.map(complete);
  const record = await Binary.wineCompatibilityRecord(install), compatibility = {};
  for (const description of [...input.included, ...input.choices]) compatibility[description.id] = Binary.compatibility(description, record,
    { executableArchitecture, macOSVersion: host.macOSVersion || systemVersionSync() });
  const roleRequested = Roles.DIRECT3D_ROLES.some(role => context.runtimeSettings?.[role.settingsKey]);
  const actual = item => {
    const files = !roleRequested && compatibility[item.id]?.files || item.files.map(file => fs.existsSync(file.path) ? Description.inspectFile(file) : file);
    compatibility[item.id].inspectedFiles = files;
    return { ...item, files, ...(['d3d-renderer', 'd3d12'].includes(item.component) && files.some(file => file.format === 'pe') ? { apis: Roles.apisForFiles(files) } : {}) };
  };
  input.included = input.included.map(actual); input.choices = input.choices.map(actual);
  const apiCompatibility = roleRequested ? Object.fromEntries(Roles.DIRECT3D_ROLES.map(role => [role.id,
    Object.fromEntries([...input.included, ...input.choices].filter(item => ['d3d-renderer', 'd3d12'].includes(item.component)).map(item => {
      const files = Plan.filesForRole(item, role), primary = files.filter(file => Roles.fileApis(file).some(api => role.apis.includes(api)));
      const imports = new Set(primary.flatMap(file => file.peImports || []));
      const requiredPaths = files.filter(file => primary.includes(file) || imports.has(path.basename(file.path).toLowerCase())).map(file => file.path);
      return [item.id, Binary.compatibility({ ...item, files, requiredPaths }, record,
        { executableArchitecture, macOSVersion: host.macOSVersion || systemVersionSync() })];
    }))])) : {};
  // MacLauncher's DXVK 2.x/3.x and vkd3d-proton cannot run on MoltenVK. With the
  // Vulkan driver on its automatic choice and no MacLauncher KosmicKrisp (a Mac
  // that cannot run it, or a download declined in this Play), each keeps the
  // runtime's own automatic choice for its Direct3D versions instead.
  const preliminary = Plan.resolvePlan({ ...input, compatibility }).components['vulkan-driver'];
  const kosmicKrispOnly = !preliminary.inherited && (preliminary.value === Plan.AUTOMATIC || preliminary.fallback && !preliminary.used)
    ? input.choices.filter(item => ownVulkanTranslator(item) && needsKosmicKrisp(item)) : [];
  if (kosmicKrispOnly.length) {
    const capable = await kosmicKrispHost(host, context);
    const installed = capable && managedDriver(input, compatibility, context, require('../../modules/shared/vulkan/managed').projectId);
    if (!capable || !installed && context.declinedChoices?.has(KOSMICKRISP_DECLINED)) {
      for (const item of kosmicKrispOnly) {
        const reason = `${item.engine === 'vkd3d-proton' ? 'vkd3d-proton' : 'This DXVK version'} needs MacLauncher KosmicKrisp, ${capable
          ? 'which is not installed' : 'which needs Metal 4 and a physical Apple GPU'}.`;
        const fallback = value => ({ ...value, compatible: false, automaticFallback: true, reason });
        compatibility[item.id] = fallback(compatibility[item.id]);
        for (const role of Object.values(apiCompatibility)) if (role[item.id]) role[item.id] = fallback(role[item.id]);
      }
    }
  }
  const plan = { ...Plan.resolvePlan({ ...input, compatibility }), layout: input.layout, compatibility, record,
    vulkanLibrarySelector: Boolean(sourceFor(runtime).vulkanLibrarySelector(install)) };
  const vulkan = plan.components['vulkan-driver'];
  const automaticVulkan = !vulkan.inherited && (vulkan.value === Plan.AUTOMATIC || vulkan.fallback && !vulkan.used);
  const videoRow = plan.components.video, selectedVideo = videoRow.selected || videoRow.used;
  if (selectedVideo && fs.existsSync(selectedVideo.root) && !(videoRow.inherited && !videoRow.fallback)) {
    // Only an actual video preparation needs the extra host-native closure.
    // Its roots come from the real launcher, never exploratory package names.
    await Binary.completeWineNativeLibraries(record, install, { nativeRoots: input.nativeRoots });
    const video = await require('../../modules/shared/runtime/native-plugin-libraries').resolvePluginLibraries(selectedVideo, record,
      { executableArchitecture, macOSVersion: host.macOSVersion || systemVersionSync() });
    compatibility[selectedVideo.id] = { ...compatibility[selectedVideo.id], compatible: true, reason: null,
      warnings: video.warnings, files: video.description.files };
    videoRow.used = video.description; videoRow.fallback = false; videoRow.reason = null;
  }
  let automaticRenderer = null, automaticAdditional = [];
  if (!sourceFor(runtime).graphicsSelector) {
    const automatic = row => row.value === Plan.AUTOMATIC || (row.fallback || row.inherited) && !row.used;
    const data=sourceFor(runtime).source||sourceFor(runtime);
    const choose=(role,selected={})=>require('./source-automatic').sourceAutomatic({source:data,role,included:input.included,compatibility,host:hardware,settings:context.runtimeSettings||{},environment:context.wineEnvironment?.settings||{},selected});
    let hardware=host;
    if(automatic(vulkan)&&host.physicalAppleGPU==null&&(data.automatic?.['vulkan-driver']||[]).some(entry=>{const id=typeof entry==='string'?entry:entry.embed;return data.embeds?.find(embed=>embed.id===id)?.interfaces?.requires?.includes('gpu:apple-physical');}))
      hardware=await require('../../modules/shared/runtime/graphics-hardware').graphicsHardware(host,{signal:context.signal});
    if(automatic(vulkan))vulkan.used=choose('vulkan-driver');
    const renderer=plan.components['d3d-renderer'];
    automaticRenderer=choose('d3d-renderer');
    const additional=choose('d3d9',{'vulkan-driver':vulkan.used});
    automaticAdditional=additional&&additional.id!==automaticRenderer?.id&&additional.apis?.every(api=>['Direct3D 8','Direct3D 9'].includes(api))?[additional]:[];
    if(automatic(renderer)){renderer.used=automaticRenderer;plan.additional=automaticAdditional.map(item=>({...item,inherited:renderer.inherited&&!renderer.fallback}));}
    if(!context.runtimeSettings?.translatorRenderer&&context.runtimeSettings?.graphicsBackend==='dxvk'){
      const selected=choose('legacy.dxvk',{'vulkan-driver':vulkan.used})||renderer.used;renderer.selected=selected;renderer.used=selected;
    }
  }
  // DirectDraw compatibility comes from the runtime's own CNC-DDraw libraries.
  if ((context.runtimeSettings?.cncDdraw === Plan.INHERIT ? context.wineEnvironment?.settings.cncDdraw : context.runtimeSettings?.cncDdraw) === true) {
    if (executableArchitecture && !['x86', 'i386'].includes(executableArchitecture)) throw new Error('DirectDraw compatibility requires a 32-bit Windows executable.');
    const directDraw = input.included.find(item => item.templateComponent === 'cnc_ddraw');
    if (!directDraw) throw new Error('The selected Wine runtime has no DirectDraw compatibility libraries.');
    plan.additional = [...(plan.additional || []), { ...directDraw, inherited: context.runtimeSettings?.cncDdraw === Plan.INHERIT }];
  }
  const actualFiles = item => {
    const files = compatibility[item.id]?.files;
    return files ? { ...item, files, form: files.find(file => file.format === 'pe')?.form || item.form } : item;
  };
  for (const row of Object.values(plan.components)) if (row.used) row.used = actualFiles(row.used);
  const automatic = Object.fromEntries(Roles.DIRECT3D_ROLES.map(role => [role.id,
    require('./source-automatic').sourceAutomatic({source:sourceFor(runtime),role:role.id,included:input.included,compatibility,host,settings:context.runtimeSettings||{},environment:context.wineEnvironment?.settings||{},selected:{'vulkan-driver':vulkan.used}})||
    (role.id==='d3d12'?null:[...automaticAdditional,...(automaticRenderer?[automaticRenderer]:[])].find(item=>!item.apis?.length||item.apis.some(api=>role.apis.includes(api)))||null)]));
  Plan.resolveApiRoles(plan, { ...input, compatibility, apiCompatibility, automatic,
    selections: Object.fromEntries(Roles.DIRECT3D_ROLES.map(role => [role.id, context.runtimeSettings?.[role.settingsKey]])),
    environment: context.wineEnvironment ? Object.fromEntries(Roles.DIRECT3D_ROLES.map(role => [role.id,
      role.id === 'd3d12' ? null : [input.environment?.selections?.['d3d-renderer']].find(item => item &&
        (!item.apis?.length || item.apis.some(api => role.apis.includes(api)))) || null])) : null });
  // MacLauncher's DXVK or vkd3d-proton pairs an automatic Vulkan driver with
  // MacLauncher KosmicKrisp, or with MacLauncher's MoltenVK scene build where
  // KosmicKrisp cannot run; both forward DLSS frames. A launch with the
  // runtime's own translators keeps the runtime's driver, and a selected or
  // inherited driver stays.
  const own = automaticVulkan ? Roles.usedRenderers(plan).filter(ownVulkanTranslator) : [];
  plan.vulkanPending = null;
  if (own.length) {
    const Managed = require('../../modules/shared/vulkan/managed'), vkd3d = own.some(item => item.engine === 'vkd3d-proton');
    const names = `MacLauncher's ${[...new Set(own.map(item => item.engine === 'vkd3d-proton' ? 'vkd3d-proton' : 'DXVK'))].join(' and ')}`;
    const capable = await kosmicKrispHost(host, context);
    const kosmicKrisp = capable && managedDriver(input, compatibility, context, Managed.projectId);
    // Only translators that run on MoltenVK use MacLauncher's MoltenVK build.
    const moltenVK = !own.some(needsKosmicKrisp);
    const scene = !kosmicKrisp && moltenVK && managedDriver(input, compatibility, context, Managed.sceneProjectId);
    const uses = own.some(item => item.engine !== 'vkd3d-proton') && vkd3d ? 'use' : 'uses';
    let reason;
    if (kosmicKrisp) { vulkan.used = actualFiles(kosmicKrisp); reason = `${names} ${uses} MacLauncher KosmicKrisp.`; }
    else {
      if (scene) vulkan.used = actualFiles(scene);
      reason = capable ? `${names} ${uses} MacLauncher KosmicKrisp, which Play installs after consent.`
        : `KosmicKrisp needs Metal 4 and a physical Apple GPU, so ${names} ${uses} MacLauncher's MoltenVK build.`;
      if (capable || !scene) plan.vulkanPending = { architecture: Architecture.targetArchitecture(input.layout?.architecture) || 'x64',
        kosmicKrisp: Boolean(capable), vkd3d: Boolean(capable) && vkd3d, carrier: moltenVK && !scene, moltenVK };
    }
    if (!vulkan.fallback) Object.assign(vulkan, { reasonCode: 'vulkan-pairing', reason });
  } else if (vulkan.selected && !vulkan.inherited && !vulkan.fallback && require('../../modules/crossover/temporal/vulkan-dlss').routeForwards(plan, executableArchitecture) &&
      !require('../../modules/crossover/temporal/vulkan-dlss').carrierDriver(plan))
    Object.assign(vulkan, { reasonCode: 'dlss-forwarding', reason: 'This Vulkan driver does not forward DLSS frames.' });
  plan.warnings = Plan.fallbackWarnings(plan);
  plan.warnings.push(...(plan.components.video.used?.videoPreparation?.warnings || []));
  if (plan.components.d3d12.used?.engine === 'vkd3d-proton' && plan.components['vulkan-driver'].used?.engine !== 'kosmickrisp')
    plan.warnings.push('KosmicKrisp is recommended for vkd3d-proton. The saved selection is being used with the selected Vulkan driver.');
  const used = value => JSON.stringify([value.apiMode, Object.values(value.components).map(row => [row.used?.id, row.used?.engine, row.used?.form, row.used?.root, row.used?.files?.map(file => [file.path, file.machine])]),
    value.placements?.map(item => [item.file.path, item.file.machine, item.roles])]);
  const previous = context.translatorPlan;
  context.translatorPlan = plan;
  if (previous && used(previous) !== used(plan)) context.invalidateGraphicsPreparation?.();
  for (const warning of plan.warnings) warn(context.logger, `[translators] ${warning}`);
  const uses = plan.apiMode ? [...plan.placements.map(item => item.description), ...['vulkan-driver', 'video'].map(key => plan.components[key].used)] : Object.values(plan.components).map(row => row.used);
  const recorded = new Set();
  for (const item of uses) if (item?.managerId) {
    const key = JSON.stringify([item.managerId, item.runtimeVersion, item.architecture, item.variant, item.root]);
    if (recorded.has(key)) continue; recorded.add(key);
    context.recordRuntimeUse?.({ managerId: item.managerId, version: item.runtimeVersion,
      architecture: item.architecture, variant: item.variant, sectionId: item.sectionId, buildKey: item.buildKey, sourcePath: item.root });
  }
  return plan;
}
return {resolve,driverRequirements};
}
module.exports={createWineResolver};
