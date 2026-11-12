// Wine settings shared by launcher backends. These entries configure an engine;
// they never select or load one.
const WINDOWS_VERSIONS = { win11: 'Windows 11', win10: 'Windows 10', win81: 'Windows 8.1', win8: 'Windows 8', win7: 'Windows 7', win2008r2: 'Windows Server 2008 R2', win2008: 'Windows Server 2008', vista: 'Windows Vista', winxp64: 'Windows XP 64-bit', winxp: 'Windows XP', win2003: 'Windows Server 2003', win2000: 'Windows 2000', winme: 'Windows ME', win98: 'Windows 98', win95: 'Windows 95' };
const inherit = value => value === undefined || value === null || value === '' || value === 'inherit';
function text(value) {
  const result = String(value);
  if (/[\0\r\n]/.test(result)) throw new Error('Wine setting values must not contain newlines or NUL bytes.');
  return result;
}
function toggle(value) { return value === true || value === 'on' || value === '1' ? '1' : '0'; }
const ENGINE_SETTINGS = {
  dxvkAsync: { component: 'd3d-renderer', engine: 'dxvk', variable: 'DXVK_ASYNC', toggle: true },
  dxvkHud: { component: 'd3d-renderer', engine: 'dxvk', variable: 'DXVK_HUD' },
  dxmtConfig: { component: 'd3d-renderer', engine: 'dxmt', variable: 'DXMT_CONFIG' },
  metalFxSpatial: { component: 'd3d-renderer', engine: 'dxmt', variable: 'DXMT_METALFX_SPATIAL_SWAPCHAIN', toggle: true },
  d3dMetalMaxFps: { component: 'd3d-renderer', engine: 'd3dmetal', variable: 'D3DM_MAX_FPS' },
  d3dMetal4: { component: 'd3d-renderer', engine: 'd3dmetal', variable: 'D3DM_MTL4', toggle: true },
  wineD3dConfig: { component: 'd3d-renderer', engine: 'wined3d', variable: 'WINE_D3D_CONFIG' },
  moltenVkFastMath: { component: 'vulkan-driver', engine: 'moltenvk', variable: 'MVK_CONFIG_FAST_MATH_ENABLED', toggle: true },
  moltenVkArgumentBuffers: { component: 'vulkan-driver', engine: 'moltenvk', variable: 'MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS', toggle: true },
  moltenVkUe4: { component: 'vulkan-driver', engine: 'moltenvk', variable: 'MVK_CONFIG_UE4_HACK_ENABLED', toggle: true },
};
function environment(settings, { needsRosetta = false, engines = {} } = {}) {
  const env = {};
  const set = (key, name, transform = text) => { if (!inherit(settings[key])) env[name] = transform(settings[key]); };
  if (needsRosetta) {
    env.DOTNET_EnableWriteXorExecute = '0';
    if (!settings.environmentReference || settings.environmentReference === 'private') env.ROSETTA_ADVERTISE_AVX = '1';
  }
  set('advertiseAvx', 'ROSETTA_ADVERTISE_AVX', toggle);
  set('metalHud', 'MTL_HUD_ENABLED', toggle);
  for (const [key, spec] of Object.entries(ENGINE_SETTINGS)) if ([].concat(engines[spec.component] || []).includes(spec.engine)) set(key, spec.variable, spec.toggle ? toggle : text);
  return env;
}
// Where NVIDIA's NGX SDK looks for its core, as Proton's wine.inf and D3DMetal
// set it. The Vulkan DLSS route stages that core in system32.
const NGX_CORE = ['HKLM\\Software\\NVIDIA Corporation\\Global\\NGXCore', 'FullPath', 'C:\\Windows\\System32'];
function registry(settings, { executable = '', ngxCore = false } = {}) {
  const commands = [], mac = 'HKCU\\Software\\Wine\\Mac Driver';
  const add = (key, name, value, type = 'REG_SZ') => commands.push(['reg.exe', 'add', key, '/v', name, '/t', type, '/d', text(value), '/f']);
  const bool = (setting, names) => { if (!inherit(settings[setting])) for (const name of names) add(mac, name, toggle(settings[setting]) === '1' ? 'Y' : 'N'); };
  bool('retina', ['RetinaMode']);
  if (!inherit(settings.dpi) || !inherit(settings.retina)) {
    const dpi = inherit(settings.dpi) ? toggle(settings.retina) === '1' ? 192 : 96 : Number(settings.dpi);
    if (!Number.isInteger(dpi) || dpi <= 0 || dpi > 0xffffffff) throw new Error('Wine DPI must be a positive REG_DWORD integer.');
    add('HKCU\\Control Panel\\Desktop', 'LogPixels', dpi, 'REG_DWORD');
    add('HKLM\\System\\CurrentControlSet\\Hardware Profiles\\Current\\Software\\Fonts', 'LogPixels', dpi, 'REG_DWORD');
  }
  bool('optionAsAlt', ['LeftOptionIsAlt', 'RightOptionIsAlt']);
  bool('commandAsCtrl', ['LeftCommandIsCtrl', 'RightCommandIsCtrl']);
  bool('mouseCapture', ['UseConfinementCursorClipping', 'CursorClippingLocksWindows']);
  bool('fullscreenCapture', ['CaptureDisplaysForFullscreen']);
  bool('verticalSync', ['AllowVerticalSync']);
  if (!inherit(settings.mouseCapture)) add('HKCU\\Software\\Wine\\DirectInput', 'MouseWarpOverride', toggle(settings.mouseCapture) === '1' ? 'force' : 'disable');
  if (!inherit(settings.crashDialog)) add('HKLM\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AeDebug', 'Debugger', toggle(settings.crashDialog) === '1' ? 'winedbg --auto %ld %ld' : 'false');
  if (!inherit(settings.virtualDesktop) && settings.virtualDesktop !== 'off') {
    if (!/^0*[1-9]\d*x0*[1-9]\d*$/.test(text(settings.virtualDesktop))) throw new Error('Virtual desktop must use WIDTHxHEIGHT.');
    add('HKCU\\Software\\Wine\\Explorer\\Desktops', 'MacLauncher', settings.virtualDesktop);
  }
  if (!inherit(settings.windowsVersion)) {
    if (!Object.hasOwn(WINDOWS_VERSIONS, settings.windowsVersion)) throw new Error('Unsupported Wine Windows version.');
    if (executable) add(`HKCU\\Software\\Wine\\AppDefaults\\${text(executable)}`, 'Version', settings.windowsVersion);
  }
  if (ngxCore) add(...NGX_CORE);
  return commands;
}
async function applyRegistry(settings, options, run) {
  let commands = registry(settings, options);
  // A stopped private prefix has a flushed registry. Replaying an unchanged
  // value would boot Wine, stop its server, then boot it again for the game.
  const current = commands.length && await options?.readCurrentRegistry?.();
  if (current) commands = commands.filter(args => {
    const file = args[2].startsWith('HKCU\\') ? 'user.reg' : 'system.reg';
    const key = args[2].replace(/^HK(?:CU|LM)\\/, '').toLowerCase(), name = args[args.indexOf('/v') + 1];
    const type = args[args.indexOf('/t') + 1], value = args[args.indexOf('/d') + 1];
    // Registry key names are case-insensitive, as other writers spell them.
    const values = Object.entries(current[file] || {}).find(([stored]) => stored.toLowerCase() === key)?.[1];
    return values?.[name] !== (type === 'REG_DWORD' ? Number(value) : value);
  });
  if (commands.length) await options?.assertWritable?.();
  for (const args of commands) await run(args);
}
function desktopArguments(settings, args, { crossover = false } = {}) {
  if (inherit(settings.virtualDesktop) || settings.virtualDesktop === 'off') return args;
  if (!/^0*[1-9]\d*x0*[1-9]\d*$/.test(text(settings.virtualDesktop))) throw new Error('Virtual desktop must use WIDTHxHEIGHT.');
  return crossover ? ['--desktop', 'MacLauncher', ...args] : ['explorer.exe', `/desktop=MacLauncher,${settings.virtualDesktop}`, ...args];
}
function explicitSettings(settings) { return Object.fromEntries(Object.entries(settings).filter(([,value]) => value !== 'inherit')); }
module.exports = { explicitSettings, ENGINE_SETTINGS, WINDOWS_VERSIONS, inherit, environment, registry, applyRegistry, desktopArguments };
