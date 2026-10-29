const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const{spawnSync}=require('node:child_process'),{writeZipArchive}=require('./helpers/zip-fixture');
const Tool=require('../src/modules/android/tools/jadx-manager'),Decompiler=require('../src/modules/android/tools/decompile');
function binaryManifest(split){
 const ns='http://schemas.android.com/apk/res/android',strings=['manifest','application','package','org.example.jadx','versionCode','versionName','1','label','JADX fixture',ns,'split',split||''];
 const index=s=>strings.indexOf(s),none=0xffffffff,chunk=(type,header,body)=>{const h=Buffer.alloc(header);h.writeUInt16LE(type);h.writeUInt16LE(header,2);h.writeUInt32LE(header+body.length,4);return Buffer.concat([h,body]);};
 let at=0;const pieces=strings.map(s=>{const b=Buffer.from(s);return Buffer.concat([Buffer.from([s.length,b.length]),b,Buffer.alloc(1)]);}),table=Buffer.alloc(strings.length*4);
 pieces.forEach((b,i)=>{table.writeUInt32LE(at,i*4);at+=b.length;});const pool=chunk(1,28,Buffer.concat([table,...pieces]));pool.writeUInt32LE(strings.length,8);pool.writeUInt32LE(0x100,16);pool.writeUInt32LE(28+table.length,20);
 const parts=[pool];function element(name,attrs,body){const ext=Buffer.alloc(20);ext.writeUInt32LE(none);ext.writeUInt32LE(index(name),4);ext.writeUInt16LE(20,8);ext.writeUInt16LE(20,10);ext.writeUInt16LE(attrs.length,12);
 const data=attrs.map(([key,value,android])=>{const a=Buffer.alloc(20);a.writeUInt32LE(android?index(ns):none);a.writeUInt32LE(index(key),4);a.writeUInt32LE(none,8);a.writeUInt16LE(8,12);a[15]=typeof value==='number'?0x10:3;a.writeUInt32LE(typeof value==='number'?value:index(value),16);return a;});parts.push(chunk(0x102,16,Buffer.concat([ext,...data])));body?.();const end=Buffer.alloc(8);end.writeUInt32LE(none);end.writeUInt32LE(index(name),4);parts.push(chunk(0x103,16,end));}
 element('manifest',[['package','org.example.jadx'],['versionCode',1,true],['versionName','1',true],...(split?[['split',split]]:[])],()=>element('application',[['label','JADX fixture',true]]));return chunk(3,8,Buffer.concat(parts));
}
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-jadx-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const output=path.join(root,'output');fs.mkdirSync(output);const apk=path.join(root,'original.apk');writeZipArchive(apk,[{name:'AndroidManifest.xml',data:binaryManifest()},{name:'classes.dex',data:Buffer.from('dex\n035\0')},{name:'lib/x86_64/original.so',data:'Original native bytes'}]);return{root,output,apk,entry:{gameId:'jadx-fixture',gamePath:apk,name:'Fixture',moduleData:{retained:true}},context:{userDataDir:path.join(root,'profile')}};}
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
test('JADX catalog is offline until explicit Refresh and selects cross-platform stable releases',async t=>{
 const{context}=setup(t);assert.deepEqual(Tool.getState(context).catalog.versions,[]);
 const release=(v,extras={})=>({tag_name:'v'+v,assets:[{name:`jadx-${v}.zip`,size:10,browser_download_url:`https://github.com/skylot/jadx/releases/download/v${v}/jadx-${v}.zip`}],...extras});
 await Tool.refreshCatalog({...context,force:true},{fetchReleases:async()=>[release('1.5.5'),release('1.5.6'),release('1.6.0'),release('2.0.0',{prerelease:true}),release('1.7.0',{assets:[]})]});
 assert.deepEqual(new Set(Tool.getState(context).catalog.versions),new Set(['1.6.0','1.5.6']));assert.equal(Tool.ui.groupId,'tools');
});
test('APK output chooser cancel has no tool, download or filesystem effects',async t=>{
 const{output,entry,context}=setup(t);let run=0;context.ui={dialog:{showOpenDialog:async()=>({canceled:true,filePaths:[]})}};
 assert.deepEqual(await Decompiler.decompileApk(entry,{},context,{run:async()=>run++}),{canceled:true});assert.equal(run,0);assert.deepEqual(fs.readdirSync(output),[]);assert.equal(entry.moduleData.jadxOutputDir,undefined);
});
test('APK action keeps original split bytes for every ABI, publishes unique output and reveals it',async t=>{
 const{root,output,apk,entry,context}=setup(t),split=path.join(root,'config.x86.apk');writeZipArchive(split,[{name:'AndroidManifest.xml',data:binaryManifest('config.x86')},{name:'lib/x86_64/extra.so',data:'Native split'}]);const before=[hash(apk),hash(split)],calls=[];
 const run=async(c,p,o)=>{calls.push(o);const dest=o.args[o.args.indexOf('--output-dir')+1];fs.mkdirSync(path.join(dest,'sources'));fs.writeFileSync(path.join(dest,'sources/Fixture.java'),'class Fixture {}');return{toolVersion:'1.5.6'};};
 const result=await Decompiler.decompileApk(entry,{outputDir:output},context,{run});assert.equal(result.status,'Decompiled');assert.equal(entry.moduleData.retained,true);assert.deepEqual([hash(apk),hash(split)],before);assert.deepEqual(calls[0].args.slice(-2),[apk,split]);assert.ok(calls[0].args.includes('none'));assert.equal(calls[0].javaArgs[0],'-Djava.awt.headless=true');assert.ok(fs.existsSync(path.join(result.outputDir,'maclauncher-jadx.json')));
 let revealed;Decompiler.revealDecompiled(entry,{}, {ui:{shell:{showItemInFolder:p=>revealed=p}}});assert.equal(revealed,result.outputDir);
 const archive=path.join(root,'original.xapk');writeZipArchive(archive,[{name:'base.apk',data:fs.readFileSync(apk)},{name:'config.x86.apk',data:fs.readFileSync(split)},{name:'unused.obb',data:'Do not expand game data'}]);const archived={...entry,gamePath:archive};await Decompiler.decompileApk(archived,{outputDir:output},context,{run});assert.equal(calls[1].args.slice(-2).length,2);assert.notEqual(entry.moduleData.jadxOutputDir,archived.moduleData.jadxOutputDir);assert.deepEqual(fs.readdirSync(output).filter(x=>x.startsWith('.')),[]);
});
test('JADX cancellation discards staged output and failure preserves a useful partial result honestly',async t=>{
 const{output,entry,context}=setup(t),controller=new AbortController();context.signal=controller.signal;
 await assert.rejects(Decompiler.decompileApk(entry,{outputDir:output},context,{run:async()=>{controller.abort();throw controller.signal.reason;}}),{name:'AbortError'});assert.deepEqual(fs.readdirSync(output),[]);delete context.signal;
 const partial=await Decompiler.decompileApk(entry,{outputDir:output},context,{run:async(c,p,o)=>{const dest=o.args[o.args.indexOf('--output-dir')+1];fs.mkdirSync(path.join(dest,'sources'));fs.writeFileSync(path.join(dest,'sources/Some.java'),'class Some {}');throw Object.assign(Error('One method failed'),{exitCode:1,toolVersion:'1.5.6'});}});assert.equal(partial.status,'Partial output');assert.equal(JSON.parse(fs.readFileSync(path.join(partial.outputDir,'maclauncher-jadx.json'))).partial,true);
 await assert.rejects(Decompiler.decompileApk(entry,{outputDir:output},context,{run:async()=>{throw Error('Launch failed');}}),/Launch failed/);assert.ok(fs.readdirSync(output).some(x=>x.endsWith('-failed.log')));
});
test('Android inspector exposes JADX without selecting or preparing an Android execution runtime',()=>{
 const module=require('../src/modules/android/main');assert.ok(module.runtimeManagers.some(x=>x.id==='jadx'));assert.equal(module.actions.decompileApk,Decompiler.decompileApk);assert.ok(module.manifest.ui.actions.find(x=>x.id==='decompileApk').cancellable);assert.ok(module.manifest.ui.actions.some(x=>x.id==='inspectGame'));assert.ok(module.manifest.ui.actions.some(x=>x.id==='importFiles'));
});
test('official JADX CLI decompiles a generated DEX APK and XML resources through the managed tool',{timeout:60000},async t=>{
 const archive=process.env.JADX_TEST_ARCHIVE,java=process.env.ANDROID_TEST_JAVA,r8=process.env.ANDROID_R8;if(!archive||!java||!r8)return t.skip('Requires official JADX ZIP, Java and D8');
 const{root,output,apk,entry,context}=setup(t),classes=path.join(root,'classes'),dex=path.join(root,'dex');fs.mkdirSync(classes);fs.mkdirSync(dex);
 const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',timeout:30000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);};
 run(path.join(path.dirname(java),'javac'),['--release','11','-d',classes,path.resolve('tests/fixtures/android-jadx/Fixture.java')]);run(java,['-cp',r8,'com.android.tools.r8.D8','--min-api','26','--output',dex,path.join(classes,'org/example/jadx/Fixture.class')]);
 writeZipArchive(apk,[{name:'AndroidManifest.xml',data:binaryManifest()},{name:'classes.dex',data:fs.readFileSync(path.join(dex,'classes.dex'))},{name:'assets/original.txt',data:'Original resource'}]);const original=hash(apk),pin=Tool.core.rowFor(context.userDataDir,'1.5.6');
 await Tool.installRuntime({...context,version:'1.5.6',confirmRuntimeInstall:async()=>true},{downloadToFile:async(url,target)=>{assert.equal(url,pin.url);fs.copyFileSync(archive,target);}});let spawned;
 const result=await Decompiler.decompileApk(entry,{version:'1.5.6',outputDir:output},{...context,onToolProcessSpawn:child=>{spawned=child;}},{run:(c,p,o)=>Tool.core.run(c,p,o,{ensureHost:async()=>({javaPath:java,runtimeIdentity:{managerId:'java',version:'fixture-21',sourcePath:path.dirname(path.dirname(java))}})})});
 assert.equal(result.status,'Decompiled');assert.match(fs.readFileSync(path.join(result.outputDir,'sources/org/example/jadx/Fixture.java'),'utf8'),/Fixture value/);assert.match(fs.readFileSync(path.join(result.outputDir,'resources/AndroidManifest.xml'),'utf8'),/org.example.jadx/);assert.equal(hash(apk),original);assert.ok(spawned&&spawned.exitCode===0);assert.ok(fs.existsSync(path.join(Tool.core.installRoot(context.userDataDir,'1.5.6'),'files/LICENSE')));t.diagnostic('Official JADX1.5.6: actual Java source, XML resources, original APK unchanged, process exit0');
});
