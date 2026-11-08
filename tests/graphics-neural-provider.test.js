const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const Neural=require("../src/modules/shared/reshade/neural"),Source=require("../src/modules/shared/reshade/neural/source.json");
test("an installed neural provider is not pinned to the source commit it was built from",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"graphics-neural-provider-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,"neural"),options={platform:"darwin",macOSVersion:"15.0",graphicsArchitecture:"arm64",hostArchitecture:"arm64"};
  fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,Source.library),"fixture");
  const descriptor={providerABI:Source.providerABI,commit:"different",library:Source.library,minimumMacOS:Source.minimumMacOS,architectures:["arm64"],files:[]};
  fs.writeFileSync(path.join(directory,"provider.json"),JSON.stringify(descriptor));
  assert.equal(Neural.resolve(root,options)?.descriptor.commit,"different");
  fs.writeFileSync(path.join(directory,"provider.json"),JSON.stringify({...descriptor,providerABI:Source.providerABI+1}));
  assert.equal(Neural.resolve(root,options),null);
});
