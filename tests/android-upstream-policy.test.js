const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const {frameworkArguments}=require('./helpers/android-java');

const source=path.resolve(__dirname,'../src/modules/android/native');
const fixtures=path.join(__dirname,'fixtures/android-framework-policy');
const javaHome=process.env.JAVA_HOME||(process.platform==='darwin'
  ?spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim():null);
const asm=JSON.parse(fs.readFileSync(path.join(source,'asm-binary.json'),'utf8')).files
  .map(file=>path.join(source,'tools',file.path)).join(path.delimiter);

function environment(){
 const env={...process.env};
 for(const key of Object.keys(env))if(/^(DYLD_|KLEPTON_|KL_|RESHADE_)/.test(key)
   ||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
 return env;
}
function temporary(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-upstream-policy-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;}
function run(tool,args){
 const result=spawnSync(path.join(javaHome,'bin',tool),args,{encoding:'utf8',env:environment(),timeout:30000,maxBuffer:16<<20});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;
}

test('Owned Android production sources contain no test fixtures or test-only entrypoints',()=>{
 const files=[];
 const visit=directory=>{for(const item of fs.readdirSync(directory,{withFileTypes:true})){
  const file=path.join(directory,item.name);if(item.isDirectory())visit(file);else files.push(file);
 }};
 visit(source);
 assert.equal(fs.existsSync(path.join(source,'test')),false,'Native fixtures belong under tests/fixtures');
 for(const file of files.filter(file=>file.endsWith('.java'))){
  assert.doesNotMatch(path.basename(file),/(?:Test|Probe|Audit)\.java$/,'Test class in production source: '+file);
  assert.doesNotMatch(fs.readFileSync(file,'utf8'),/\b\w+ForTest(?:ing)?\s*\(/,'Test-only entrypoint in production source: '+file);
 }
 for(const file of files.filter(file=>/\.(?:c|cc|cpp|h|hpp|m|mm)$/.test(file))){
  const text=fs.readFileSync(file,'utf8');
  assert.doesNotMatch(text,/^\s*#\s*(?:if|ifdef|ifndef|define)\b[^\n]*\b\w*(?:_TEST|_TESTING|TEST_)\w*/m,
   'Native test switches belong under tests/fixtures: '+file);
  assert.doesNotMatch(text,/\bJava_\w*(?:Probe|Test|Audit)_\w+\b/,
   'Native test entrypoints belong under tests/fixtures: '+file);
 }
});

test('Host artifact defines no classes owned by the upstream framework',t=>{
 if(!javaHome)return t.skip('Java 21 is required');
 const framework=frameworkArguments('javac',[])[1];
 const host=path.join(path.dirname(framework),'android-host.jar');
 const upstream=new Set(run('jar',['--list','--file',framework]).split('\n')
  .filter(name=>name.endsWith('.class')&&!name.startsWith('maclauncher/')));
 const hostClasses=run('jar',['--list','--file',host]).split('\n').filter(name=>name.endsWith('.class'));
 const duplicates=hostClasses.filter(name=>upstream.has(name)).sort();
 assert.deepEqual(duplicates,[],
  'Host classes hide upstream implementations. Move platform behavior to named adapters; no framework-class exceptions are allowed.');
 const generatedContract=name=>{
  for(const prefix of ['maclauncher/android/framework/clients/','maclauncher/android/framework/endpoints/'])
   if(name.startsWith(prefix)&&upstream.has(name.slice(prefix.length)))return true;
  return false;
 };
 assert.deepEqual(hostClasses.filter(name=>!generatedContract(name)&&/(?:^|\/)(?:test(?:s)?|fixtures)(?:\/|$)|(?:Test|Probe|Audit)(?:\$[^/]*)?\.class$/i.test(name)),[],
  'Test fixtures and audit classes belong only in test outputs, never android-host.jar.');
});

test('Every owned JNI declaration retains its exported or registered native implementation',t=>{
 if(!javaHome||process.platform!=='darwin')return t.skip('Java 21 and macOS are required');
 const framework=frameworkArguments('javac',[])[1],runtime=path.dirname(framework),directory=temporary(t);
 const libraries=fs.readdirSync(path.join(runtime,'native')).filter(name=>name.endsWith('.dylib')).map(name=>path.join(runtime,'native',name));
 assert.ok(libraries.length>0,'Runtime native libraries are required');
 const symbols=spawnSync('nm',['-gUj',...libraries],{encoding:'utf8',timeout:30000,maxBuffer:32<<20});
 assert.equal(symbols.error,undefined);assert.equal(symbols.status,0,symbols.stderr);
 const file=path.join(directory,'symbols.txt');
 fs.writeFileSync(file,[...new Set(symbols.stdout.split('\n').filter(line=>line.startsWith('_Java_')).map(line=>line.slice(1)))].join('\n'));
 const agent=path.join(directory,'registrations.dylib'),registered=path.join(directory,'registered.txt');
 const compiled=spawnSync('clang',['-dynamiclib','-I'+path.join(javaHome,'include'),'-I'+path.join(javaHome,'include/darwin'),path.join(fixtures,'NativeRegistrations.c'),'-o',agent],{encoding:'utf8',timeout:30000});
 assert.equal(compiled.error,undefined);assert.equal(compiled.status,0,compiled.stderr);
 const classpath=[directory,asm,path.join(runtime,'android-host.jar'),framework].join(path.delimiter);
 run('javac',['--release','21','-cp',classpath,'-d',directory,path.join(fixtures,'OwnedNativeSymbols.java')]);
 const output=run('java',[...require('../src/modules/android/jvm-options').frameworkJvmOptions,'-agentpath:'+agent+'='+registered,'-cp',classpath,'OwnedNativeSymbols',path.join(runtime,'android-host.jar'),file,path.resolve(__dirname,'../src/modules/android/native/loader-entry.c'),runtime,registered]);
 assert.match(output,/PASS \d+ owned native declarations/);t.diagnostic(output.trim());
});

test('Native catalog reads actual registry entries without spelling or package eligibility rules',async t=>{
 if(process.platform!=='darwin')return t.skip('macOS libc++ is required');
 const directory=temporary(t),library=path.join(directory,'registry.dylib');
 const result=spawnSync('clang++',['-std=c++20','-g','-O0','-dynamiclib',
  path.join(fixtures,'native-catalog/HostRuntime.cpp'),path.join(fixtures,'native-catalog/LayoutlibLoader.cpp'),'-o',library],{encoding:'utf8',timeout:30000});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
 const {frameworkNativeCatalog}=await import('../src/modules/android/native/framework-native-catalog.mjs');
 // Independent source fixture has short, slash, dot and foreign-package keys.
 // None depends on the producer's symbol/string discovery implementation.
 assert.deepEqual(frameworkNativeCatalog(library),{
  core:['a','android.util.Log','android/util/Log','future.publisher.Native$Nested'],
  graphics:['outside.graphics.with.a.long.registry.key','x/y/Z']
 });
});

test('Registration selection follows final class bytes across the complete publisher registry',async t=>{
 if(!javaHome||process.platform!=='darwin')return t.skip('Java 21 and macOS libc++ are required');
 const directory=temporary(t),library=path.join(directory,'registry.dylib');
 const result=spawnSync('clang++',['-std=c++20','-g','-O0','-dynamiclib',
  path.join(fixtures,'native-catalog/HostRuntime.cpp'),path.join(fixtures,'native-catalog/LayoutlibLoader.cpp'),'-o',library],{encoding:'utf8',timeout:30000});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
 run('javac',['--release','21','-cp',asm,'-d',directory,path.join(source,'framework/FrameworkNativeDeclarations.java'),path.join(fixtures,'NativeCatalogDeclarationsProbe.java')]);
 run('java',['-cp',directory+path.delimiter+asm,'NativeCatalogDeclarationsProbe',directory]);
 const declarations=path.join(directory,'declarations.tsv'),file=path.join(directory,'native-families.properties');
 run('java',['-cp',directory+path.delimiter+asm,'FrameworkNativeDeclarations',path.join(directory,'original.jar'),path.join(directory,'adapted.jar'),declarations]);
 const {writeFrameworkNativeCatalog}=await import('../src/modules/android/native/framework-native-catalog.mjs');
 writeFrameworkNativeCatalog(library,file,declarations);
 // Expected values come from the independent C++ registry and class fixtures.
 // An outer Java adapter must not suppress its nested remaining native entry;
 // unknown groups and absent classes cannot justify omitting implementations.
 assert.equal(fs.readFileSync(file,'utf8').split('\n').slice(0,2).join('\n')+'\n',
  'core=android.util.Log,android/util/Log,future.publisher.Native$Nested\n'+
  'graphics=outside.graphics.with.a.long.registry.key,x/y/Z\n');
});

test('Publisher bootstrap retains its complete native object families',async t=>{
 if(!javaHome||process.platform!=='darwin')return t.skip('Java 21 and macOS publisher binary are required');
 const publisher=process.env.KLEPTON_AOSP_FRAMEWORK;
 if(!publisher)return t.skip('KLEPTON_AOSP_FRAMEWORK is required for the publisher comparison');
 const framework=frameworkArguments('javac',[])[1],runtime=path.dirname(framework),directory=temporary(t);
 const library=path.join(runtime,'native/libandroid_runtime.dylib');
 const declarations=path.join(directory,'declarations.tsv');
 run('javac',['--release','21','-cp',asm,'-d',directory,path.join(source,'framework/FrameworkNativeDeclarations.java')]);
 run('java',['-cp',directory+path.delimiter+asm,'FrameworkNativeDeclarations',publisher,framework,declarations]);
 const {writeFrameworkNativeCatalog}=await import('../src/modules/android/native/framework-native-catalog.mjs');
 const file=path.join(directory,'native-families.properties');const catalog=writeFrameworkNativeCatalog(library,file,declarations);
 const supplied=new Set(Object.values(catalog).flat());
 const entries=Object.fromEntries(fs.readFileSync(file,'utf8').trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1).split(',')];}));
 assert.equal(entries.core.includes('com.android.internal.util.VirtualRefBasePtr'),true,'VectorDrawable retains the publisher RefBase ownership');
 for(const name of ['android.content.res.ApkAssets','android.content.res.AssetManager','android.content.res.StringBlock','android.content.res.XmlBlock'])assert.equal(entries.core.includes(name),true,'Resources share the publisher graphics representation');
 assert.ok(entries.graphics.length>0,'Publisher graphics registrations remain available for native declarations');
 assert.ok(entries.core.includes('android.util.Log'),'Logging must retain publisher registration');
 assert.equal(entries.core.includes('android.util.jar.StrictJarFile'),false,'A fully implemented ZIP native boundary does not register the incompatible ART ZIP owner');
 assert.equal(catalog.core.length,27,'Pinned publisher core registry has 27 actual entries');
 assert.equal(catalog.graphics.length,51,'Pinned publisher graphics registry has 51 actual entries');
 t.diagnostic(`${supplied.size} inspected publisher families; graphics and resources retain publisher registration`);
});

test('Original publisher logging native methods are callable after ordinary bootstrap',t=>{
 if(!javaHome||process.platform!=='darwin'||!process.env.KLEPTON_NATIVE_RUNTIME)return t.skip('Java 21 and KLEPTON_NATIVE_RUNTIME are required');
 const runtime=path.resolve(process.env.KLEPTON_NATIVE_RUNTIME),directory=temporary(t);
 const cp=['android-host.jar','android-framework.jar'].map(name=>path.join(runtime,name)).join(path.delimiter);
 run('javac',['--release','21','-cp',cp,'-d',directory,path.join(fixtures,'NativeLoggingProbe.java')]);
 const options=require('../src/modules/android/jvm-options').frameworkJvmOptions;
 const output=run('java',[...options,'-Xverify:all','-cp',directory+path.delimiter+cp,'NativeLoggingProbe',runtime]);
 assert.match(output,/PASS original publisher logging/);
});

test('Normalized archive preserves every upstream class and callable method',t=>{
 if(!javaHome)return t.skip('Java 21 is required');
 const publisher=process.env.KLEPTON_AOSP_FRAMEWORK;
 if(!publisher)return t.skip('KLEPTON_AOSP_FRAMEWORK is required for the publisher comparison');
 const directory=temporary(t),framework=frameworkArguments('javac',[])[1];
 run('javac',['--release','21','-cp',asm,'-d',directory,path.join(fixtures,'FrameworkArchiveAudit.java')]);
 assert.match(run('java',['-cp',directory+path.delimiter+asm,'FrameworkArchiveAudit',publisher,framework]),/PASS publisher archive preserved/);
});

test('Implementation checker rejects replacement bodies and control-flow bypasses independently',t=>{
 if(!javaHome)return t.skip('Java 21 is required');
 const directory=temporary(t);
 run('javac',['--release','21','-cp',asm,'-d',directory,
  path.join(fixtures,'FrameworkImplementationAudit.java'),path.join(fixtures,'FrameworkImplementationProbe.java')]);
 assert.match(run('java',['-cp',directory+path.delimiter+asm,'FrameworkImplementationProbe']),/PASS 48 independent implementation audit cases/);
});

test('Normalized archive retains every publisher Java implementation through exact platform boundaries',t=>{
 if(!javaHome)return t.skip('Java 21 is required');
 const publisher=process.env.KLEPTON_AOSP_FRAMEWORK;
 if(!publisher)return t.skip('KLEPTON_AOSP_FRAMEWORK is required for the publisher comparison');
 const directory=temporary(t),framework=frameworkArguments('javac',[])[1];
 run('javac',['--release','21','-cp',asm,'-d',directory,path.join(fixtures,'FrameworkImplementationAudit.java')]);
 const output=run('java',['-Xmx2g','-cp',directory+path.delimiter+asm,'FrameworkImplementationAudit',publisher,framework]);
 assert.match(output,/PASS publisher Java implementations preserved/);t.diagnostic(output.trim());
});

test('Storage adapters retain complete upstream Java bodies and only bind the actual platform boundary',t=>{
 if(!javaHome)return t.skip('Java 21 is required');
 const publisher=process.env.KLEPTON_AOSP_FRAMEWORK;
 if(!publisher)return t.skip('KLEPTON_AOSP_FRAMEWORK is required for the publisher comparison');
 const directory=temporary(t),framework=frameworkArguments('javac',[])[1],host=path.join(path.dirname(framework),'android-host.jar');
 assert.equal(fs.existsSync(path.join(source,'framework/PackagePortability.java')),false,'Original ApplicationPackageManager must retain its ContextImpl owner');
 assert.equal(fs.existsSync(path.join(source,'java/maclauncher/android/framework/HostContentResolver.java')),false,'Original ApplicationContentResolver must own provider access');
 for(const name of ['HostParcel','HostBinder'])assert.equal(fs.existsSync(path.join(source,'java/maclauncher/android/framework',name+'.java')),false,'Original native Binder/Parcel own storage and references');
 run('javac',['--release','21','-cp',asm,'-d',directory,
  ...['NativeBindings','FilesystemPortability'].map(name=>path.join(source,'framework',name+'.java')),
  path.join(fixtures,'StorageBodiesProbe.java')]);
 assert.match(run('java',['-cp',[directory,asm,host].join(path.delimiter),'StorageBodiesProbe',publisher]),/PASS \d+ original Environment Java bodies, unmodified StorageManager client/);
});

test('Native adapters bind only exact compiled implementations and preserve every other method',t=>{
 if(!javaHome)return t.skip('Java 21 is required');
 const directory=temporary(t);
 run('javac',['--release','21','-cp',asm,'-d',directory,path.join(source,'framework/NativeBindings.java'),path.join(fixtures,'NativeBindingsProbe.java')]);
 assert.match(run('java',['-Xverify:all','-cp',directory+path.delimiter+asm,'NativeBindingsProbe']),/PASS exact native bindings/);
});

test('Native initialization derives new owners without hand-selected class lists',t=>{
 if(!javaHome)return t.skip('Java 21 is required');
 const directory=temporary(t),framework=frameworkArguments('javac',[])[1];
 run('javac',['--release','21','-cp',asm+path.delimiter+framework,'-d',directory,
  path.join(source,'framework/GraphicsPortability.java'),path.join(source,'java-jvm/maclauncher/android/framework/JvmNativeMemory.java'),path.join(source,'java/maclauncher/android/framework/HostCrypto.java'),
  path.join(fixtures,'NativeInitializationProbe.java')]);
 assert.match(run('java',['-Xverify:all','-cp',[directory,asm,framework].join(path.delimiter),'NativeInitializationProbe']),/PASS derived native initializer registration and lazy class initialization/);
});

test('Resource adaptations preserve original algorithms and derive the native array ABI',t=>{
 if(!javaHome)return t.skip('Java 21 is required');
 const publisher=process.env.KLEPTON_AOSP_FRAMEWORK;
 if(!publisher)return t.skip('KLEPTON_AOSP_FRAMEWORK is required for the publisher comparison');
 const directory=temporary(t);
 run('javac',['--release','21','-cp',asm,'-d',directory,
  path.join(source,'portability/PortableCalls.java'),path.join(source,'portability/NioPortability.java'),path.join(source,'framework/ResourcePortability.java'),
  path.join(fixtures,'ResourceBoundaryProbe.java')]);
 assert.match(run('java',['-Xverify:all','-cp',directory+path.delimiter+asm,'ResourceBoundaryProbe',publisher]),/PASS \d+ original resource method bodies and derived native array ABI/);
});

test('Upstream surface checker detects missing and inherited APIs without filtering native dependencies',t=>{
 if(!javaHome)return t.skip('Java 21 is required');
 const directory=temporary(t);
 run('javac',['--release','21','-cp',asm,'-d',directory,
  path.join(fixtures,'FrameworkSurfaceAudit.java'),path.join(fixtures,'FrameworkSurfaceProbe.java')]);
 assert.match(run('java',['-Xverify:all','-cp',directory+path.delimiter+asm,'FrameworkSurfaceProbe',directory]),/PASS 6 framework surface audit cases/);
});

test('Portable framework families execute directly from AOSP without duplicate source classes',t=>{
 if(!javaHome)return t.skip('Java 21 is required');
 const directory=temporary(t),framework=frameworkArguments('javac',[])[1];
 run('javac',['--release','21','-cp',framework,'-d',directory,path.join(fixtures,'PortableFamilyProbe.java')]);
 assert.match(run('java',['-Xverify:all','-cp',directory+path.delimiter+framework,'PortableFamilyProbe']),/PASS raw AOSP collections, codecs, value types, JSON and XML interface/);
 for(const family of ['org/json','org/xmlpull','com/android/internal/util']) {
  const root=path.join(source,'java',family);
  if(fs.existsSync(root))assert.equal(fs.readdirSync(root,{recursive:true}).filter(file=>file.endsWith('.java')).length,0,'Upstream family is shadowed: '+family);
 }
 const utility=path.join(source,'java/android/util');
 assert.deepEqual(fs.existsSync(utility)?fs.readdirSync(utility).filter(file=>file.endsWith('.java')):[],[],'AOSP owns the complete utility family');
});

test('Built host preserves the complete upstream public and protected API',t=>{
 if(!javaHome)return t.skip('Java 21 is required');
 const directory=temporary(t),framework=frameworkArguments('javac',[])[1],host=path.join(path.dirname(framework),'android-host.jar');
 const classes=path.join(directory,'host');fs.mkdirSync(classes);
 const extracted=spawnSync('/usr/bin/unzip',['-q',host,'-d',classes],{encoding:'utf8',timeout:30000});
 assert.equal(extracted.status,0,extracted.stderr);
 run('javac',['--release','21','-cp',asm,'-d',directory,path.join(fixtures,'FrameworkSurfaceAudit.java')]);
 run('java',['-cp',directory+path.delimiter+asm,'FrameworkSurfaceAudit',framework,classes,path.join(directory,'surface.json')]);
});

test('Raw AOSP device metadata and Java/native properties share the Klepton owner',t=>{
 if(!javaHome||process.platform!=='darwin')return t.skip('macOS and Java 21 are required');
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(!runtime)return t.skip('KLEPTON_NATIVE_RUNTIME is required for the native property bridge');
 const directory=temporary(t),framework=path.resolve(runtime,'android-framework.jar'),host=path.resolve(runtime,'android-host.jar');
 run('javac',['--release','21','-cp',framework+path.delimiter+host,'-d',directory,path.join(fixtures,'PropertyFamilyProbe.java')]);
 assert.match(run('java',['-Xverify:all','-Xcheck:jni','-cp',directory+path.delimiter+host+path.delimiter+framework,
  'PropertyFamilyProbe',path.resolve(runtime,'native/libklepton-jvm.dylib'),path.resolve(runtime,'native/libnativebinding.dylib')]),
  /PASS raw AOSP Build\/SystemProperties, shared native values and borrowed owner handles/);
});

test('Raw AOSP text owns span mutation and selection state',t=>{
 if(!javaHome||process.platform!=='darwin')return t.skip('macOS and Java 21 are required');
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(!runtime)return t.skip('KLEPTON_NATIVE_RUNTIME is required for native framework properties');
 const directory=temporary(t),framework=path.resolve(runtime,'android-framework.jar'),host=path.resolve(runtime,'android-host.jar');
 run('javac',['--release','21','-cp',framework+path.delimiter+host,'-d',directory,path.join(fixtures,'TextFamilyProbe.java')]);
 assert.match(run('java',['-Xverify:all','-Xcheck:jni','-cp',directory+path.delimiter+host+path.delimiter+framework,
  'TextFamilyProbe',path.resolve(runtime,'native/libklepton-jvm.dylib'),path.resolve(runtime,'native/libnativebinding.dylib')]),
  /PASS raw AOSP span mutation, selection, immutable copies, text encoding and filters/);
 const text=path.join(source,'java/android/text');
 assert.equal(fs.existsSync(text)?fs.readdirSync(text,{recursive:true}).filter(file=>file.endsWith('.java')).length:0,0,'AOSP owns text implementations');
});

test('Raw AOSP content values preserve complete matching and independent state',t=>{
 if(!javaHome||process.platform!=='darwin')return t.skip('macOS and Java 21 are required');
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(!runtime)return t.skip('KLEPTON_NATIVE_RUNTIME is required for native framework properties');
 const directory=temporary(t),framework=path.resolve(runtime,'android-framework.jar'),host=path.resolve(runtime,'android-host.jar');
 run('javac',['--release','21','-cp',framework+path.delimiter+host,'-d',directory,path.join(fixtures,'ContentFamilyProbe.java')]);
 assert.match(run('java',['-Xverify:all','-Xcheck:jni','-cp',directory+path.delimiter+host+path.delimiter+framework,
  'ContentFamilyProbe',path.resolve(runtime,'native/libklepton-jvm.dylib'),path.resolve(runtime,'native/libnativebinding.dylib')]),
  /PASS raw AOSP intent copies, URI encoding, complete path filters, package metadata and clipboard data/);
});

test('Media adaptations bind exact native methods and retain every upstream Java implementation',t=>{
 if(!javaHome)return t.skip('Java 21 is required');
 const publisher=process.env.KLEPTON_AOSP_FRAMEWORK;
 if(!publisher)return t.skip('KLEPTON_AOSP_FRAMEWORK is required for publisher descriptors');
 const directory=temporary(t),framework=frameworkArguments('javac',[])[1];
 const host=path.join(path.dirname(framework),'android-host.jar');
 run('javac',['--release','21','-cp',asm,'-d',directory,path.join(source,'framework/NativeBindings.java'),path.join(fixtures,'MediaBoundaryProbe.java')]);
 assert.match(run('java',['-cp',[directory,asm,host].join(path.delimiter),'MediaBoundaryProbe',publisher]),/PASS \d+ exact media native bindings and \d+ unchanged upstream methods/);
});

test('Subclass checker detects hidden concrete algorithms through classes and default interfaces',t=>{
 if(!javaHome)return t.skip('Java 21 is required');
 const directory=temporary(t);
 run('javac',['--release','21','-cp',asm,'-d',directory,
  path.join(fixtures,'FrameworkSubclassAudit.java'),path.join(fixtures,'FrameworkSubclassProbe.java')]);
 assert.match(run('java',['-Xverify:all','-cp',directory+path.delimiter+asm,'FrameworkSubclassProbe',directory]),
  /PASS subclass audit detects inherited, owned-intermediate and interface-default bypasses/);
});

test('Host subclasses preserve concrete upstream Java implementations',t=>{
 if(!javaHome)return t.skip('Java 21 is required');
 const publisher=process.env.KLEPTON_AOSP_FRAMEWORK;
 if(!publisher)return t.skip('KLEPTON_AOSP_FRAMEWORK is required for the publisher comparison');
 const directory=temporary(t),framework=frameworkArguments('javac',[])[1];
 const host=path.join(path.dirname(framework),'android-host.jar'),classes=path.join(directory,'host');fs.mkdirSync(classes);
 const extracted=spawnSync('/usr/bin/unzip',['-q',host,'-d',classes],{encoding:'utf8',timeout:30000});
 assert.equal(extracted.status,0,extracted.stderr);
 run('javac',['--release','21','-cp',asm,'-d',directory,path.join(fixtures,'FrameworkSubclassAudit.java')]);
 assert.match(run('java',['-cp',directory+path.delimiter+asm,'FrameworkSubclassAudit',publisher,classes,path.join(directory,'subclasses.json')]),
  /PASS no alternate concrete framework algorithms/);
});
