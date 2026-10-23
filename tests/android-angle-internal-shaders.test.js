const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('Embedded ANGLE Metal library initializes and renders original offscreen GLES',t=>{
 const{ANDROID_ANGLE_INTERNAL:provider,ANDROID_ANGLE_HEADERS:headers}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!provider||!headers)return t.skip('Requires the original Metal ANGLE supplier and headers');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-angle-internal-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const run=(program,args)=>{const r=spawnSync(program,args,{encoding:'utf8',timeout:60000,maxBuffer:1<<20});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r;};
 const executable=path.join(directory,'probe');run('/usr/bin/xcrun',['clang++','-std=c++20','-arch','arm64','-mmacosx-version-min=13.0','-I'+path.resolve(headers),path.resolve('tests/fixtures/android-native/angle-metal-internal-probe.cpp'),'-o',executable]);
 const manifest=JSON.parse(fs.readFileSync(path.join(provider,'angle-manifest.json')));assert.equal(manifest.internalMetalShaders,'embedded-metallib');
 if(process.env.ANDROID_ANGLE_BASELINE){const baseline=JSON.parse(run(executable,[path.resolve(process.env.ANDROID_ANGLE_BASELINE)]).stdout);assert.equal(baseline.pixelCorrect,true);t.diagnostic('Original runtime-source provider '+JSON.stringify(baseline));}
 const actual=JSON.parse(run(executable,[path.resolve(provider)]).stdout);assert.equal(actual.pixelCorrect,true);t.diagnostic('Embedded original Metal library '+JSON.stringify(actual));
});
