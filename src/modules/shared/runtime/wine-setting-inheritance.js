const Wine = require('./wine-settings');
// Read only the reference selected in Settings; never enumerate real environments.
function choices(settings, schema, { reference = settings.environmentReference, readEnvironment } = {}) {
  const record = (readEnvironment || require('./wine-environment').readEnvironment)(reference);
  if (!record) return { inheritedValues: [] };
  const label = record.kind === 'sikarugir-wrapper' ? 'Wrapper setting' : 'Bottle setting';
  const raw = record.environment || {}, registries = record.registry || {};
  const current = key => {
    if (key === 'dlss') {
      const values = [raw.D3DM_ENABLE_METALFX, raw.DXMT_ENABLE_NVEXT].filter(value => value !== undefined);
      if (values.length) return values.some(value => value === '1') ? 'on' : 'off';
    }
    if (key === 'wineD3dConfig' && raw.WINE_D3D_CONFIG === undefined) {
      const values = registries['user.reg']?.['Software\\Wine\\Direct3D'];
      if (values) return Object.entries(values).map(([name,value]) => name + '=' + value).join(',');
    }
    if (key === 'dllOverrides' && raw.WINEDLLOVERRIDES === undefined) {
      const values = registries['user.reg']?.['Software\\Wine\\DllOverrides'];
      if (values) return Object.entries(values).map(([name,value]) => name + '=' + value).join(';');
    }
    if (record.settings?.[key] !== undefined) return record.settings[key];
    const variable = Wine.ENGINE_SETTINGS[key]?.variable || ({ advertiseAvx: 'ROSETTA_ADVERTISE_AVX', metalHud: 'MTL_HUD_ENABLED', locale: 'LANG', dllOverrides: 'WINEDLLOVERRIDES', wineDebug: 'WINEDEBUG' })[key];
    if (variable) return raw[variable];
    const probe = key === 'dpi' ? 96 : key === 'windowsVersion' ? 'win10' : key === 'virtualDesktop' ? '1920x1080' : 'on';
    const command = Wine.registry({ [key]: probe })[0];
    if (command) {
      const keyPath = command[2].replace(/^HK(?:CU|LM)\\/, ''), name = command[command.indexOf('/v') + 1];
      for (const file of command[2].startsWith('HKCU') ? ['user.reg','userdef.reg'] : ['system.reg']) {
        const value = registries[file]?.[keyPath]?.[name];
        if (value !== undefined) return value;
      }
    }
    if (key === 'environment') return Object.entries(raw).map(([k,v]) => `${k}=${v}`).join('; ');
    if (key === 'arguments') return record.metadata?.['Program Flags'];
    if (key === 'executable') return record.metadata?.['Program Name and Path'];
    if (key === 'bottleTemplate') return record.metadata?.Template;
    return undefined;
  };
  return { effectiveSettings: Object.entries(record.settings || {}).filter(([,value]) => value !== undefined && typeof value !== "object").map(([key,value]) => ({value:key,label:String(value)})), inheritedValues: schema.fields.filter(field => field.inheritFrom).map(field => {
    const value = current(field.key);
    return { value: field.key, label: `${label} (${value === undefined || value === '' ? 'runtime default' : String(value)})` };
  }) };
}
module.exports = { choices };
