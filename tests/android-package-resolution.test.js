const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
function run(command,args){const result=spawnSync(command,args,{encoding:'utf8',timeout:30000,maxBuffer:4<<20});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;}
test('Local package resolver adapters retain original matching and result ordering',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/modules/android/native/java/maclauncher/android/framework/HostPackages.java'),'utf8');
 assert.match(source,/extends com\.android\.server\.IntentResolver<IntentEntry,ResolveInfo>/);
 assert.match(source,/sortResults\(List<ResolveInfo> values\)\{values\.sort\(com\.android\.server\.pm\.resolution\.ComponentResolver\.RESOLVE_PRIORITY_SORTER\);\}/);
 assert.match(source,/return queryIntent\(null,intent,type,\(flags&PackageManager\.MATCH_DEFAULT_ONLY\)!=0,user,flags\)/);
 assert.doesNotMatch(source,/Comparator\.comparing|boolean\s+intentMatchesFilter\s*\(|void\s+buildResolveList\s*\(/);
});
test('Original package parser and resolver consume configured split APK service filters without starting application code',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,config=process.env.KLEPTON_PACKAGE_CONFIG;
 if(process.platform!=='darwin'||!runtime||!config)return t.skip('Requires a built runtime and inspected APK configuration declaring Firebase messaging services');
 const home=process.env.JAVA_HOME||run('/usr/libexec/java_home',['-v','21']).trim();
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-package-intents-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.resolve('src/modules/android/native/java/maclauncher/android/framework/HostPackages.java'),path.join(__dirname,'fixtures/android-framework-services/PackageIntentProbe.java'),path.join(__dirname,'fixtures/android-window-session/RuntimeFixture.java')]);
 assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'PackageIntentProbe',path.resolve(runtime),temporary,path.resolve(config)]),/PASS original package parser and resolver/);
});
