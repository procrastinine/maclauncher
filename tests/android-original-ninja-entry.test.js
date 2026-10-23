const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');

test('Original Soong UI config and Kati entry preserve the evaluated graph and supply upstream pool policy',t=>{
  const tool=process.env.ANDROID_SOONG_UI_TOOL,source=process.env.ANDROID_SOONG_ENTRY_SOURCE,ninja=process.env.ANDROID_NINJA;
  if(!tool||!source||!ninja)return t.skip('Requires the original Soong UI tool, source inputs and Ninja');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-original-entry-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const name of ['build','prebuilts'])fs.symlinkSync(path.join(source,name),path.join(root,name));
  fs.symlinkSync('build/soong/root.bp',path.join(root,'Android.bp'));
  const env={...process.env,OUT_DIR:'out',TARGET_PRODUCT:'original_entry_probe',TARGET_BUILD_VARIANT:'userdebug',NINJA_HIGHMEM_NUM_JOBS:'3'};
  const configFile=path.join(root,'configuration.json'),entryFile=path.join(root,'entry.json');
  execFileSync(tool,['--developer-ninja-config',configFile],{cwd:root,env,stdio:'pipe'});
  const config=JSON.parse(fs.readFileSync(configFile));
  assert.equal(config.highmemParallel,3,'The upstream environment override determines pool depth');
  const graph='rule original\n  command = cp $in $out\n  pool = highmem_pool\nbuild original.result: original original.input\n';
  fs.writeFileSync(config.sourceGraph,graph);fs.mkdirSync(config.packageInput,{recursive:true});
  fs.writeFileSync(path.join(config.packageInput,'dist.mk'),'');
  fs.writeFileSync(path.join(root,config.soongOutDir,'soong_phony_targets.mk'),'');
  execFileSync(tool,['--developer-ninja-entry',entryFile],{cwd:root,env,stdio:'pipe'});
  const entry=JSON.parse(fs.readFileSync(entryFile));
  assert.equal(entry.sourceGraph,config.sourceGraph);assert.equal(entry.katiSuffix,config.katiSuffix);
  assert.equal(fs.readFileSync(config.sourceGraph,'utf8'),graph,'The original evaluated actions remain unchanged');
  assert.equal(execFileSync(ninja,['-f',entry.buildFile,'-t','inputs','original.result'],{cwd:root,encoding:'utf8'}).trim(),'original.input');
  assert.ok(entry.metadataFiles.every(file=>fs.existsSync(file)),'Both original included graphs participate in build identity');
  assert.throws(()=>execFileSync(ninja,['-f',entry.buildFile,'-t','inputs','missing-target'],{cwd:root,stdio:'pipe'}),/Command failed/);
});
