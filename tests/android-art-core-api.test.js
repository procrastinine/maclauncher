const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('whole shared ART sources compile against Android core and reject a host-only executor',async t=>{
 const {JAVA_HOME:jdk,KLEPTON_NATIVE_RUNTIME:runtime,ANDROID_ART_CORE_API:core}=process.env;
 if(!jdk||!runtime||!core)return t.skip('Requires Java, the complete framework archive and Android compiler core image');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-core-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const {compileArtSources}=await import('../src/modules/android/art/build-java.mjs');
 const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):e.isFile()&&e.name.endsWith('.java')?[path.join(d,e.name)]:[]);
 const common=walk(path.resolve('src/modules/android/native/java')),art=walk(path.resolve('src/modules/android/art/java'));
 const sources=[...common,...art,path.resolve('tests/fixtures/android-art-core/WebKitDefaultProbe.java')],classes=path.join(root,'classes');fs.mkdirSync(classes);
 const options={jdk,core,api:path.resolve(runtime,'android-framework.jar'),sharedClasses:path.resolve(runtime,'android-host.jar'),classes,sources};
 compileArtSources(options);
 const probe=spawnSync(path.join(jdk,'bin/java'),['-cp',[classes,options.sharedClasses,options.api].join(path.delimiter),'WebKitDefaultProbe'],{encoding:'utf8',timeout:20000});
 assert.ifError(probe.error);assert.equal(probe.status,0,probe.stdout+probe.stderr);assert.match(probe.stdout,/PASS shared WebKit proxy/);
 const forbidden=path.join(root,'HostOnly.java');fs.writeFileSync(forbidden,'class HostOnly { Object create(){return java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor();} }');
 assert.throws(()=>compileArtSources({...options,sources:[forbidden]}));
 assert.ok(common.length);assert.ok(fs.existsSync('src/modules/android/native/java-jvm/maclauncher/android/framework/JvmNativeMemory.java'));
});
