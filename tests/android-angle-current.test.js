const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process'),{pathToFileURL}=require('node:url');

test('failed ANGLE context binding restores the original owner and never exposes an incomplete framebuffer',async t=>{
 if(process.platform!=='darwin')return t.skip('Requires the macOS C++ compiler');
 const angle=process.env.ANDROID_ANGLE_SOURCE;
 if(!angle)return t.skip('Requires the pinned ANGLE source checkout');
 const native=path.resolve(process.env.ANDROID_NATIVE_SOURCE||'src/modules/android/native');
 const {adaptAngleCurrentBindings}=await import(pathToFileURL(path.join(native,'angle-current-source.mjs')).href);
 const original=fs.readFileSync(path.join(angle,'src/libANGLE/Display.cpp'),'utf8');
 const template=fs.readFileSync(path.join(__dirname,'fixtures/android-native/angle-current/binding.cpp.in'),'utf8');
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-angle-current-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 for(const [name,text] of [['baseline',original],['fixed',adaptAngleCurrentBindings(original)]]){
  const from=text.indexOf('Error Display::makeCurrent(Thread *thread,'),to=text.indexOf('\nError Display::restoreLostDevice()',from);
  assert(from>=0&&to>from,'The pinned original function boundary is required');
  const source=path.join(output,name+'.cpp'),binary=path.join(output,name);
  fs.writeFileSync(source,template.replace('/* CURRENT_BINDING_SOURCE */',text.slice(from,to)));
  const built=spawnSync('xcrun',['clang++','-std=c++20','-Wall','-Wextra','-Werror',source,'-o',binary],{encoding:'utf8',timeout:30000});
  assert.equal(built.status,0,built.stderr);assert.equal(built.error,undefined);
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});assert.equal(run.error,undefined);
  if(name==='baseline'){assert.notEqual(run.status,0);assert.match(run.stderr,/t.current==nullptr/);}
  else{
   assert.equal(run.signal,null,run.stderr);assert.equal(run.status,0,run.stderr);
   assert.equal(run.stdout.split('\n').filter(line=>line.startsWith('PASS ')).length,10);
   assert.match(run.stdout,/failed same-context surface transition/);
   assert.match(run.stdout,/pending-destroy original survives/);
   assert.match(run.stdout,/genuine restoration failure marks original context lost without replacing first error/);
  }
 }
});
