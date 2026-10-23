const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');

test('ANGLE application cache identity contains its real serializer version',async t=>{
 const provider=process.env.ANDROID_ANGLE_IDENTITY,baseline=process.env.ANDROID_ANGLE_BASELINE,headers=process.env.ANDROID_ANGLE_HEADERS;
 if(process.platform!=='darwin'||!provider||!baseline||!headers)return t.skip('Requires current and previous ANGLE providers');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-angle-identity-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const run=(program,args)=>{const r=spawnSync(program,args,{encoding:'utf8',timeout:30000,maxBuffer:1<<20});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const executable=path.join(directory,'probe');
 run('/usr/bin/xcrun',['clang++','-std=c++20','-I'+path.resolve(headers),path.resolve('tests/fixtures/android-native/angle-identity-probe.cpp'),'-o',executable]);
 const manifest=JSON.parse(fs.readFileSync(path.join(provider,'angle-manifest.json')));
 const key=actual=>crypto.createHash('sha1').update(actual.version+actual.renderer).digest('hex');
 for(const backend of ['metal',...(process.env.KL_MVK_DYLIB?['vulkan']:[])]){
  const old=JSON.parse(run(executable,[path.resolve(baseline),backend]));
  const actual=JSON.parse(run(executable,[path.resolve(provider),backend]));
  assert.equal(actual.renderer,old.renderer,'The selected renderer retains its original identity');
  assert.ok(actual.version.startsWith(backend==='vulkan'?'OpenGL ES 3.1.0 (ANGLE ':'OpenGL ES 3.0.0 (ANGLE '));
  assert.ok(actual.version.includes('git hash: '+manifest.angleRevision.slice(0,12)));
  assert.ok(actual.version.includes('program binary: '+manifest.programBinaryVersion));
  assert.equal(actual.binaryVersion,manifest.programBinaryVersion.slice(0,16));
  assert.notEqual(key(actual),key(old),'Application-owned caches select a distinct canonical driver key');
  assert.equal(actual.roundtrip,true);assert.equal(actual.incompatibleRejected,true);
  t.diagnostic(backend+' '+JSON.stringify({previous:old,actual,previousCacheKey:key(old),cacheKey:key(actual)}));
 }
});

test('ANGLE version changes with its generated binary format at the same source revision',async t=>{
 const {prepareAngleIdentity}=await import('../src/modules/android/native/angle-identity-source.mjs');
 const source=process.env.ANDROID_ANGLE_SOURCE;
 if(process.platform!=='darwin'||!source)return t.skip('Requires pinned ANGLE source');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-angle-version-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const revision=JSON.parse(fs.readFileSync(path.resolve('src/modules/android/native/angle-source.json'))).revision;
 prepareAngleIdentity(path.resolve(source),directory,revision);
 const common=path.join(directory,'src/common');
 fs.writeFileSync(path.join(common,'angle_commit.h'),'#define ANGLE_COMMIT_HASH "'+revision.slice(0,12)+'"\n#define ANGLE_COMMIT_POSITION 0\n');
 fs.writeFileSync(path.join(directory,'probe.cpp'),'#include "angle_version.h"\n#include <cstdio>\nint main(){puts(ANGLE_VERSION_STRING);}\n');
 const version=hash=>{
  fs.writeFileSync(path.join(common,'ANGLEShaderProgramVersion.h'),'#define ANGLE_PROGRAM_VERSION "'+hash+'"\n');
  const compile=spawnSync('/usr/bin/xcrun',['clang++','-I'+common,path.join(directory,'probe.cpp'),'-o',path.join(directory,'probe')],{encoding:'utf8',timeout:10000});assert.equal(compile.status,0,compile.stderr);
  const r=spawnSync(path.join(directory,'probe'),[],{encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();
 };
 const first=version('11111111111111111111111111111111'),next=version('22222222222222222222222222222222');
 assert.ok(first.includes('git hash: '+revision.slice(0,12)));assert.notEqual(first,next);
 assert.ok(first.endsWith('program binary: 11111111111111111111111111111111'));
 assert.ok(next.endsWith('program binary: 22222222222222222222222222222222'));
});
