const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');

test('Original native package AIDL clients share the installed Java package catalog',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME,recipeFile=process.env.ANDROID_BINDER_BUILD,aidl=process.env.AIDL,native=process.env.AOSP_NATIVE_SOURCE;
 if(process.platform!=='darwin'||!runtime||!home||!recipeFile||!aidl||!native)return t.skip('Requires the original Binder build, pinned AOSP native source, AIDL and Java21');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-packages-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const run=(tool,args)=>{const result=spawnSync(tool,args,{encoding:'utf8',timeout:30000,maxBuffer:4<<20});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 const source=path.resolve('src/modules/android/native'),pins=JSON.parse(fs.readFileSync(source+'/source-pins.json')),recipe=JSON.parse(fs.readFileSync(recipeFile));
 const originals=directory+'/aidl',generated=directory+'/generated',headers=directory+'/include';for(const dir of [originals,generated,headers])fs.mkdirSync(dir);
 // The upstream interface owns its complete import closure and transaction IDs.
 const inputs=new Map();const include=name=>{if(inputs.has(name))return;const relative=name.replaceAll('.','/')+'.aidl',text=run('git',['-C',native,'show',pins.aospNative+':libs/binder/aidl/'+relative]);inputs.set(name,relative);const file=path.join(originals,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);for(const match of text.matchAll(/^import\s+([\w.]+)\s*;/gm))include(match[1]);};
 include('android.content.pm.IPackageManagerNative');
 for(const relative of inputs.values())run(aidl,['--lang=cpp','-I'+originals,'-o'+generated,'-h'+headers,path.join(originals,relative)]);
 const library=directory+'/libnative-packages-probe.dylib';
 run('clang++',[...recipe.flags,'-I'+headers,'-dynamiclib',path.resolve('tests/fixtures/android-native/NativePackagesProbe.cpp'),...Array.from(inputs.values(),name=>path.join(generated,name.replace(/\.aidl$/,'.cpp'))),recipe.library,'-Wl,-rpath,'+path.dirname(recipe.library),'-o',library]);
 run('codesign',['--force','--sign','-',library]);
 const cp=[directory,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
 run(home+'/bin/javac',['--release','21','-cp',cp,'-d',directory,source+'/java/maclauncher/android/framework/HostNativePackages.java',source+'/java/maclauncher/android/framework/HostPackages.java',path.resolve('tests/fixtures/android-framework-services/NativePackagesProbe.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')]);
 assert.match(run(home+'/bin/java',['-Xverify:all','-cp',cp,'maclauncher.android.fixture.NativePackagesProbe',path.resolve(runtime),directory,library]),/PASS complete original native package AIDL/);
});
