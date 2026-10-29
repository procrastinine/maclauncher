const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Models=require('../src/modules/shared/reshade/neural/models');
const manager=require('../src/modules/shared/reshade/runtime/neural-models-manager');
const {selectNeuralModel}=require('../src/modules/shared/effects/neural-selection.mjs');
const version=c=>'sha256-'+c.repeat(64);
function fixture(t){
  const userDataDir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'neural-defaults-')));t.after(()=>fs.rmSync(userDataDir,{recursive:true,force:true}));
  const a=version('a'),b=version('b'),nr=version('c'),external='/Existing/Compatible.srmodel';
  const rows=[a,b,external].map(id=>({version:id,operation:'mlx-sr-image',compatibleMethods:['mlx-sr-image','mlx-sr-scene'],ready:true}));
  rows.push({version:nr,operation:'mlx-dlss',ready:true});
  t.mock.method(Models,'listInstalled',()=>rows);
  const previous={defaultVersion:nr,defaultVersions:{'mlx-sr-image':a,'mlx-sr-scene':a,'mlx-dlss':nr}};
  const select=(payload,settings=previous)=>{
    const next=manager.applySettingsUpdate('setDefault',payload,settings,{userDataDir});
    return manager.updateSettingsAfterDefault(next,payload,{userDataDir,previousSettings:settings});
  };
  return {a,b,nr,external,rows,previous,select};
}
test('choosing a model default changes one declared operation, including a multi-operation package',t=>{
  const f=fixture(t),next=f.select({selectionId:'mlx-sr-image',version:f.b});
  assert.deepEqual(next.defaultVersions,{'mlx-sr-image':f.b,'mlx-sr-scene':f.a,'mlx-dlss':f.nr});
  assert.equal(next.defaultVersion,f.nr);
  assert.equal(selectNeuralModel('mlx-sr-image',f.rows,next).version,f.b);
  assert.equal(selectNeuralModel('mlx-sr-scene',f.rows,next).version,f.a);
  assert.equal(f.previous.defaultVersions['mlx-sr-image'],f.a);
});
test('registered model paths use the same operation preference without changing the section registration default',t=>{
  const f=fixture(t),settings={...f.previous,customDefaults:{default:'/Existing/NR.dlssmodel'}};
  const next=f.select({selectionId:'mlx-sr-image',version:f.external},settings);
  assert.equal(next.defaultVersions['mlx-sr-image'],f.external);
  assert.equal(next.defaultVersions['mlx-sr-scene'],f.a);
  assert.deepEqual(next.customDefaults,settings.customDefaults);
});
test('invalid, absent and incompatible model defaults leave every preference intact',t=>{
  const f=fixture(t),saved=structuredClone(f.previous);
  for(const payload of [{selectionId:'unknown',version:f.a},{selectionId:'mlx-dlss',version:f.a},{selectionId:'mlx-sr-image',version:version('f')}])
    assert.throws(()=>f.select(payload),/supported model operation|installed model compatible/);
  assert.deepEqual(f.previous,saved);
  const reset=f.select({selectionId:'mlx-sr-image',version:null});
  assert.deepEqual(reset.defaultVersions,{'mlx-sr-scene':f.a,'mlx-dlss':f.nr});
});
