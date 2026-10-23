const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('Original ARM32 generated declarations preserve bytes and native input timestamps',async t=>{
  const bionicSource=process.env.ANDROID_BIONIC_SOURCE,include=process.env.ANDROID_NDK_HEADERS,
    importsDirectory=process.env.ANDROID_ARM32_IMPORTS,python=process.env.ANDROID_PYTHON;
  if(!bionicSource||!include||!importsDirectory||!python)return t.skip('Requires original Bionic, NDK and generated import declarations');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-declarations-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const {prepareElf32}=await import('../src/modules/android/native/arm32/elf-source.mjs');
  const {prepareSyscalls}=await import('../src/modules/android/native/arm32/syscall-sources.mjs');
  const output=path.join(directory,'arm32'),syscalls=path.join(output,'syscalls');
  fs.mkdirSync(output,{recursive:true});
  const generate=()=>{prepareElf32({bionicSource,output});prepareSyscalls({bionicSource,include,python,importsDirectory,output:syscalls});};
  generate();
  const files=['bionic-packed.h','bionic-stdio.h','bionic-new.cpp',...['syscalls.inc','syscalls.json','prctl-constants.h','capability-constants.h','securebits.h','netlink-constants.h','at-constants.h','binfmt-constants.h'].map(name=>'syscalls/'+name)];
  const before=files.map(name=>fs.readFileSync(path.join(output,name)));
  const retained=new Date(1000000000000);
  for(const name of files)fs.utimesSync(path.join(output,name),retained,retained);
  generate();
  for(const [index,name]of files.entries()){
    assert.deepEqual(fs.readFileSync(path.join(output,name)),before[index],name+' bytes');
    assert.equal(fs.statSync(path.join(output,name)).mtimeMs,retained.getTime(),name+' timestamp');
    const canonical=path.join(importsDirectory,'..',name);
    assert.deepEqual(fs.readFileSync(path.join(output,name)),fs.readFileSync(canonical),name+' retains the existing generated ABI');
  }
});

test('Clang driver jobs reuse warm and independent products and rebuild actual header dependents',async t=>{
  if(process.platform!=='darwin'||process.arch!=='arm64')return t.skip('Requires Darwin ARM64');
  const python=process.env.ANDROID_PYTHON,ninja=process.env.ANDROID_NINJA;
  if(!python||!ninja)return t.skip('Requires project Python and pinned Ninja');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android host cache '));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const {compileHostLibrary}=await import('../src/modules/android/native/host-compile.mjs');
  fs.writeFileSync(path.join(directory,'value.h'),'#define VALUE 3\n');
  fs.writeFileSync(path.join(directory,'value.c'),'#include "value.h"\nint value(void){return VALUE;}\nconst char *source_path(void){return __FILE__;}\n');
  fs.writeFileSync(path.join(directory,'other.c'),'int other(void){return 7;}\n');
  fs.writeFileSync(path.join(directory,'assembly.S'),'.text\n.globl _assembled\n_assembled:\nmov w0, #5\nret\n');
  fs.writeFileSync(path.join(directory,'mixed.mm'),'#import <Foundation/Foundation.h>\n#include <string>\nextern "C" int mixed(void){@autoreleasepool{return (int)[@"abcd" length]+(int)std::string("a").size();}}\n');
  const build=(version,inputs=['value.c','other.c','assembly.S','mixed.mm'])=>{const output=path.join(directory,version);fs.mkdirSync(output,{recursive:true});return compileHostLibrary({name:'test.dylib',inputs:inputs.map(file=>path.join(directory,file)),flags:['-arch','arm64','-mmacosx-version-min=13.0','-O1'],extra:['-lc++','-framework','Foundation'],directory:path.join(directory,'objects'),output:path.join(output,'test.dylib'),cwd:directory,ninja,python,pathRoots:[[path.join(directory,'provider-'+version),'/src/provider']]});};
  const times=files=>files.map(file=>fs.statSync(file,{bigint:true}).mtimeNs);
  fs.writeFileSync(path.join(directory,'probe.c'),'#include <dlfcn.h>\n#include <stdio.h>\nint main(int n,char **v){if(n<3)return 1;void *h=dlopen(v[1],RTLD_NOW);if(!h)return 2;for(int i=2;i<n;i++){int(*f)(void)=dlsym(h,v[i]);if(!f)return 3;printf("%s%d",i==2?"":" ",f());}return 0;}\n');
  const compile=spawnSync('clang',[path.join(directory,'probe.c'),'-o',path.join(directory,'probe')],{encoding:'utf8'});assert.equal(compile.status,0,compile.stderr);
  const probe=(library,symbols)=>{const run=spawnSync(path.join(directory,'probe'),[library,...symbols],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);return run.stdout;};
  const first=build('first'),before=times(first.objects),unchanged=[...first.objects,first.output,path.join(directory,'first/test.dylib')],warm=times(unchanged);
  const symbols=['value','other','assembled','mixed'];
  assert.equal(first.objects.length,4);assert.equal(probe(path.join(directory,'first/test.dylib'),symbols),'3 7 5 5');
  build('first');assert.deepEqual(times(unchanged),warm,'An unchanged warm build retains objects, link output and publication');
  build('second');assert.deepEqual(times(unchanged),warm,'A new publication reuses the same compiled and linked product');
  const independentSource=path.join(directory,'independent.c');fs.writeFileSync(independentSource,'int independent(void){return 31;}\n');
  const independent=()=>compileHostLibrary({name:'independent.dylib',inputs:[independentSource],flags:['-arch','arm64','-O1'],directory:path.join(directory,'objects'),cwd:directory,ninja,python});
  const separate=independent(),separateFiles=[...separate.objects,separate.output],separateBefore=times(separateFiles);
  assert.equal(probe(separate.output,['independent']),'31');
  fs.writeFileSync(independentSource,'int independent(void){return 53;}\n');independent();
  assert.ok(times(separateFiles).every((value,index)=>value>separateBefore[index]),'The edited independent product actually recompiles and links');
  assert.equal(probe(separate.output,['independent']),'53');
  build('first');assert.deepEqual(times(unchanged),warm,'An independent product change leaves this target completely reusable');
  fs.writeFileSync(path.join(directory,'value.h'),'#define VALUE 11\n');build('third');
  const after=times(first.objects);
  assert.ok(after[0]>before[0]);assert.equal(after[1],before[1]);assert.equal(after[2],before[2]);assert.equal(after[3],before[3]);
  assert.equal(probe(path.join(directory,'third/test.dylib'),symbols),'11 7 5 5','The changed header reaches execution while unrelated units keep their behavior');
  const published=fs.readFileSync(path.join(directory,'third/test.dylib'));
  assert.equal(published.includes(Buffer.from(directory)),false,'Publication removes local debug object references');
  assert.equal(published.includes(Buffer.from(fs.realpathSync(directory))),false,'Canonical temporary paths are also mapped');
  assert.ok(published.includes(Buffer.from('/build/value.c')),'Source assertions retain a stable useful filename');
  build('fourth',['value.c','assembly.S','mixed.mm']);
  assert.equal(fs.existsSync(first.objects[1]),false,'Removed translation units leave no cached objects');
  assert.ok(fs.existsSync(path.join(directory,'first/test.dylib'))&&fs.existsSync(path.join(directory,'third/test.dylib')),'Cache pruning preserves completed outputs');
});

test('Native publication removes build RPATH and debug records while preserving exports and unchanged bytes',async t=>{
  if(process.platform!=='darwin')return t.skip('Requires Darwin Mach-O tools');
  const {execFileSync}=require('node:child_process');
  const {nativePathFlags,publishNativeBinary}=await import('../src/modules/android/native/upstream/native-paths.mjs');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android private build '));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const source=path.join(directory,'source.c'),library=path.join(directory,'library.dylib'),publication=path.join(directory,'published/library.dylib');
  fs.writeFileSync(source,'const char *filename(void){return __FILE__;}\nint value(void){return 9;}\n');
  execFileSync('clang',['-g',...nativePathFlags({source:directory}),'-dynamiclib',source,'-Wl,-install_name,@rpath/library.dylib','-Wl,-rpath,'+directory,'-o',library]);
  publishNativeBinary(library,publication,{rpaths:['@loader_path']});
  const bytes=fs.readFileSync(publication);assert.equal(bytes.includes(Buffer.from(directory)),false);assert.equal(bytes.includes(Buffer.from(fs.realpathSync(directory))),false);
  assert.ok(bytes.includes(Buffer.from('/src/upstream/source.c')));
  assert.match(execFileSync('nm',['-gU',publication],{encoding:'utf8'}),/_value/);
  const commands=execFileSync('otool',['-l',publication],{encoding:'utf8'});assert.match(commands,/path @loader_path \(offset/);assert.ok(!commands.split('\n').slice(1).join('\n').includes(directory));
  const before=fs.statSync(publication,{bigint:true}).mtimeNs;publishNativeBinary(library,publication,{rpaths:['@loader_path']});
  assert.equal(fs.statSync(publication,{bigint:true}).mtimeNs,before,'Unchanged publication retains compiler input timestamps');
  assert.ok(fs.readFileSync(library).includes(Buffer.from(directory)),'Private cached linker metadata remains available locally');
});

test('Native objects and executables share Clang dependency reuse without republishing intermediate files',async t=>{
  if(process.platform!=='darwin'||process.arch!=='arm64')return t.skip('Requires Darwin ARM64');
  const python=process.env.ANDROID_PYTHON,ninja=process.env.ANDROID_NINJA;
  if(!python||!ninja)return t.skip('Requires project Python and pinned Ninja');
  const {compileHostObject,compileHostExecutable}=await import('../src/modules/android/native/host-compile.mjs');
  const {cachedBuildStep}=await import('../src/modules/android/native/upstream/build-step.mjs');
  const {execFileSync}=require('node:child_process');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android object cache '));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const header=path.join(directory,'value.h'),source=path.join(directory,'value.c'),main=path.join(directory,'main.c');
  fs.writeFileSync(header,'#define VALUE 7\n');
  fs.writeFileSync(source,'#include "value.h"\nint value(void){return VALUE * FACTOR;}\n');
  fs.writeFileSync(main,'#include <stdio.h>\nint value(void);int main(void){printf("%d",value());}\n');
  const common={directory:path.join(directory,'objects'),cwd:directory,ninja,python,flags:['-arch','arm64','-O2']};
  const publication=path.join(directory,'published/value.o');
  const object=()=>compileHostObject({...common,name:'value.o',inputs:[source],extra:['-DFACTOR=2'],output:publication});
  const ar=fs.realpathSync(execFileSync('xcrun',['--find','ar'],{encoding:'utf8'}).trim()),archive=path.join(directory,'libvalue.a');let archives=0;
  const pack=()=>cachedBuildStep({cache:path.join(directory,'archive.reuse.json'),inputs:[ar,publication],files:[archive],
    key:{args:['rcs',archive,publication]},build(){archives++;execFileSync(ar,['rcs',archive,publication]);}});
  const program=input=>compileHostExecutable({...common,name:'program',inputs:[main,input]});
  const first=object(),executable=program(first.output),times=files=>files.map(file=>fs.statSync(file,{bigint:true}).mtimeNs);
  assert.equal(execFileSync(executable.output,{encoding:'utf8'}),'14');
  const before=times([first.output,...executable.objects,executable.output]);
  assert.equal(await pack(),true);const publicationBefore=times([publication,archive]);
  assert.equal(object().output,first.output);program(first.output);
  assert.equal(await pack(),false);assert.deepEqual(times([publication,archive]),publicationBefore,'Unchanged published objects do not recreate downstream archives');
  assert.deepEqual(times([first.output,...executable.objects,executable.output]),before,'Unchanged intermediate objects retain their actual compiler output identity');
  fs.writeFileSync(source,fs.readFileSync(source));object();
  assert.deepEqual(times([publication,archive]),publicationBefore,'Identical recompiled object bytes preserve delivery metadata');
  assert.equal(await pack(),false);assert.equal(archives,1);
  fs.writeFileSync(header,'#define VALUE 11\n');object();program(first.output);
  assert.equal(await pack(),true);assert.equal(archives,2,'A real header-dependent object change rebuilds its archive');
  const after=times([first.output,...executable.objects,executable.output]);
  assert.ok(after[0]>before[0]);assert.deepEqual(after.slice(1,-1),before.slice(1,-1),'Only the header-dependent object recompiles');
  assert.ok(after.at(-1)>before.at(-1),'The executable links its changed object');
  assert.equal(execFileSync(executable.output,{encoding:'utf8'}),'22');
});

test('Java producer cache preserves unchanged work and removes deleted classes on rebuild',async t=>{
  const jdk=process.env.JAVA_HOME;if(!jdk)return t.skip('Requires JDK 21');
  const {execFileSync}=require('node:child_process');
  const {cachedBuildStep}=await import('../src/modules/android/native/upstream/build-step.mjs');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-java-cache-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const source=path.join(directory,'source'),classes=path.join(directory,'classes');fs.mkdirSync(source);
  fs.writeFileSync(path.join(source,'Main.java'),'public class Main { public static void main(String[] a){System.out.print(1);} }\n');
  fs.writeFileSync(path.join(source,'Retired.java'),'public class Retired {}\n');
  const javac=path.join(jdk,'bin/javac'),java=path.join(jdk,'bin/java');let compilations=0;
  const build=()=>cachedBuildStep({cache:path.join(directory,'java.reuse.json'),key:{release:21},
    inputs:[javac,...fs.readdirSync(source).map(name=>path.join(source,name))],trees:[classes],build(){
      compilations++;execFileSync(javac,['--release','21','-d',classes,...fs.readdirSync(source).map(name=>path.join(source,name))]);
    }});
  assert.equal(await build(),true);const before=fs.statSync(path.join(classes,'Main.class'),{bigint:true}).mtimeNs;
  assert.equal(await build(),false);assert.equal(compilations,1);assert.equal(fs.statSync(path.join(classes,'Main.class'),{bigint:true}).mtimeNs,before);
  fs.writeFileSync(path.join(directory,'native.c'),'int changed_native_bridge;\n');
  assert.equal(await build(),false,'Native-only edits do not repeat framework compilation');
  fs.rmSync(path.join(source,'Retired.java'));
  fs.writeFileSync(path.join(source,'Main.java'),'public class Main { public static void main(String[] a){System.out.print(2);} }\n');
  assert.equal(await build(),true);assert.equal(compilations,2);assert.equal(fs.existsSync(path.join(classes,'Retired.class')),false);
  assert.equal(execFileSync(java,['-cp',classes,'Main'],{encoding:'utf8'}),'2');
  fs.rmSync(path.join(classes,'Main.class'));assert.equal(await build(),true,'Missing products rebuild');
  fs.writeFileSync(path.join(classes,'Orphan.class'),'stale');assert.equal(await build(),true,'Unexpected products cannot enter a later archive');
  assert.equal(fs.existsSync(path.join(classes,'Orphan.class')),false);assert.equal(await build(),false);
});

test('Producer reuse never associates an old output with inputs edited during production',async t=>{
  const {cachedBuildStep}=await import('../src/modules/android/native/upstream/build-step.mjs');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-producer-inputs-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const source=path.join(directory,'source'),output=path.join(directory,'output'),cache=path.join(directory,'reuse.json');
  fs.writeFileSync(source,'original');let mutations=1,produced=0,sameContent=true;
  const build=()=>cachedBuildStep({cache,inputs:[source],files:[output],key:{producer:'copy'},build(){
    produced++;fs.writeFileSync(output,fs.readFileSync(source));
    if(mutations-- > 0){const before=fs.statSync(source);fs.writeFileSync(source,sameContent?'original':'version'+produced);fs.utimesSync(source,before.atime,before.mtime);}
  }});
  assert.equal(await build(),true);assert.equal(produced,2,'One concurrent rewrite gets one fresh rebuild, even with identical content and restored mtime');
  assert.equal(fs.readFileSync(output,'utf8'),'original');assert.equal(await build(),false);
  fs.writeFileSync(source,'unstable');mutations=Infinity;sameContent=false;
  await assert.rejects(build(),/Build input kept changing during production/);
  assert.equal(produced,4,'Repeated edits stop after the bounded retry');
  assert.equal(fs.existsSync(cache),false,'An inconsistent producer invocation leaves no reusable cache');
  mutations=0;assert.equal(await build(),true);assert.equal(fs.readFileSync(output,'utf8'),'version4');
  assert.equal(await build(),false);assert.equal(produced,5);
});

test('Generated JNI declarations retain native objects across Java-only changes',async t=>{
  const jdk=process.env.JAVA_HOME,python=process.env.ANDROID_PYTHON,ninja=process.env.ANDROID_NINJA;
  if(process.platform!=='darwin'||!jdk||!python||!ninja)return t.skip('Requires Darwin, JDK21, project Python and Ninja');
  const {execFileSync}=require('node:child_process');
  const {cachedBuildStep}=await import('../src/modules/android/native/upstream/build-step.mjs');
  const {synchronizeSourceTree}=await import('../src/modules/android/native/upstream/source-files.mjs');
  const {compileHostObject}=await import('../src/modules/android/native/host-compile.mjs');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-jni-declarations-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const source=path.join(directory,'source'),classes=path.join(directory,'classes'),generated=path.join(directory,'generated'),published=path.join(directory,'jni');fs.mkdirSync(source);
  const main=path.join(source,'Main.java'),retired=path.join(source,'Retired.java'),header=path.join(published,'Main.h');
  fs.writeFileSync(main,'public class Main { public native int value(); public int helper(){return 1;} }\n');
  fs.writeFileSync(retired,'public class Retired { public native void retired(); }\n');
  const javac=path.join(jdk,'bin/javac');
  const build=async()=>{await cachedBuildStep({cache:path.join(directory,'java.reuse.json'),key:{release:21},inputs:[javac,...fs.readdirSync(source).map(name=>path.join(source,name))],trees:[classes,generated],build(){execFileSync(javac,['--release','21','-d',classes,'-h',generated,...fs.readdirSync(source).map(name=>path.join(source,name))]);}});synchronizeSourceTree(generated,published);};
  fs.writeFileSync(path.join(directory,'native.c'),'#include "Main.h"\nint native_width(void){return sizeof(jint);}\n');
  const compile=()=>compileHostObject({name:'native.o',inputs:[path.join(directory,'native.c')],flags:['-I'+published,'-I'+path.join(jdk,'include'),'-I'+path.join(jdk,'include/darwin')],directory:path.join(directory,'objects'),cwd:directory,ninja,python});
  await build();const object=compile().output,headerTime=fs.statSync(header,{bigint:true}).mtimeNs,objectTime=fs.statSync(object,{bigint:true}).mtimeNs;
  fs.writeFileSync(main,'public class Main { public native int value(); public int helper(){return 2;} }\n');
  await build();compile();assert.equal(fs.statSync(header,{bigint:true}).mtimeNs,headerTime);assert.equal(fs.statSync(object,{bigint:true}).mtimeNs,objectTime,'Java implementation edits retain native objects');
  fs.writeFileSync(main,'public class Main { public native int value(int argument); public int helper(){return 2;} }\n');fs.rmSync(retired);
  await build();compile();assert.ok(fs.statSync(header,{bigint:true}).mtimeNs>headerTime);assert.ok(fs.statSync(object,{bigint:true}).mtimeNs>objectTime,'Changed JNI declarations rebuild actual compiler dependents');
  assert.equal(fs.existsSync(path.join(published,'Retired.h')),false,'Removed native classes retire their published declarations');
});

test('Native workspace lock follows the build process through exec',async t=>{
  const python=process.env.ANDROID_PYTHON;if(!python)return t.skip('Requires project Python');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-build-lock-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const moduleFile=path.resolve(__dirname,'../src/modules/android/native/build-workspace.mjs');
  const entry=path.join(directory,'entry.mjs'),output=path.join(directory,'result'),workspace=path.join(directory,'workspace');
  fs.writeFileSync(entry,`import fs from 'node:fs';import {enterBuildWorkspace} from ${JSON.stringify(require('node:url').pathToFileURL(moduleFile).href)};const i=process.argv.indexOf('--workspace-fd');const held=enterBuildWorkspace({directory:${JSON.stringify(workspace)},output:${JSON.stringify(output)},python:${JSON.stringify(python)},entry:process.argv[1],args:[],fd:i<0?undefined:Number(process.argv[i+1])});if(held)fs.writeFileSync(${JSON.stringify(output)},'held');`);
  const run=spawnSync(process.execPath,[entry],{encoding:'utf8',timeout:15000});assert.equal(run.status,0,run.stdout+run.stderr);assert.equal(fs.readFileSync(output,'utf8'),'held');
  const released=spawnSync(python,['-c','import fcntl,os,sys\nf=os.open(sys.argv[1],os.O_RDWR)\nfcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\n',path.join(workspace,'build.lock')],{encoding:'utf8'});assert.equal(released.status,0,released.stderr);
});

test('Failed builds remove only their own incomplete output and preserve reusable work',async t=>{
  const python=process.env.ANDROID_PYTHON;if(!python||process.platform!=='darwin')return t.skip('Requires project Python and Darwin process events');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-build-output-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const moduleFile=require('node:url').pathToFileURL(path.resolve(__dirname,'../src/modules/android/native/build-workspace.mjs')).href;
  const workspace=path.join(directory,'workspace'),entry=path.join(directory,'entry.mjs');
  fs.writeFileSync(entry,`import fs from 'node:fs';import {spawnSync} from 'node:child_process';import {enterBuildWorkspace} from ${JSON.stringify(moduleFile)};const descriptor=name=>{const i=process.argv.indexOf(name);return i<0?undefined:Number(process.argv[i+1]);};const output=process.env.OUTPUT;const held=enterBuildWorkspace({directory:${JSON.stringify(workspace)},output,python:${JSON.stringify(python)},entry:process.argv[1],args:[],fd:descriptor('--workspace-fd'),outputFd:descriptor('--output-fd'),manageOutput:true});if(held){fs.writeFileSync(${JSON.stringify(path.join(workspace,'object.o'))},'cached');fs.writeFileSync(output+'/partial','partial');switch(process.env.MODE){case 'prepare':throw Error('Preparation failed');case 'compile':process.exit(spawnSync(process.execPath,['-e','process.exit(9)']).status);case 'replace':fs.renameSync(output,output+'.moved');fs.mkdirSync(output);fs.writeFileSync(output+'/existing','retained');process.exit(7);default:fs.writeFileSync(output+'/complete','complete');}}`);
  const run=(mode,output)=>spawnSync(process.execPath,[entry],{env:{...process.env,MODE:mode,OUTPUT:output},encoding:'utf8',timeout:15000});
  for(const mode of ['prepare','compile']){
    const output=path.join(directory,mode),result=run(mode,output);
    assert.equal(result.status,mode==='compile'?9:1,result.stderr);
    assert.equal(fs.existsSync(output),false,'Failed invocation removes its partial products');
    assert.equal(fs.readFileSync(path.join(workspace,'object.o'),'utf8'),'cached','Stable compiler work survives');
    const retry=run('complete',output);assert.equal(retry.status,0,retry.stderr);
    const existing=run('compile',output);assert.equal(existing.status,1,existing.stderr);
    assert.equal(fs.readFileSync(path.join(output,'complete'),'utf8'),'complete','A preexisting completed runtime is never removed');
  }
  const replaced=path.join(directory,'replaced'),result=run('replace',replaced);assert.equal(result.status,7,result.stderr);
  assert.equal(fs.readFileSync(path.join(replaced,'existing'),'utf8'),'retained','A replacement path is not owned by the failed invocation');
  assert.equal(fs.readFileSync(path.join(replaced+'.moved','partial'),'utf8'),'partial');
});

test('Workspace cancellation retires compiler descendants before admitting another builder',async t=>{
  const python=process.env.ANDROID_PYTHON;if(!python||process.platform!=='darwin')return t.skip('Requires project Python and Darwin process events');
  const {spawn}=require('node:child_process'),{once}=require('node:events');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-build-retire-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const moduleFile=require('node:url').pathToFileURL(path.resolve(__dirname,'../src/modules/android/native/build-workspace.mjs')).href;
  const workspace=path.join(directory,'workspace'),output=path.join(directory,'result'),entry=path.join(directory,'entry.mjs');
  const leaf=path.join(directory,'leaf.py'),compiler=path.join(directory,'compiler.py');
  fs.writeFileSync(leaf,`import os,signal,sys,time\nfrom pathlib import Path\ndef retire(signum,frame):\n    time.sleep(0.35)\n    Path(sys.argv[1]+'.retired').write_text('retired')\n    sys.exit(0)\nsignal.signal(signal.SIGTERM,retire)\nPath(sys.argv[1]+'.leaf').write_text(str(os.getpid()))\nwhile True: signal.pause()\n`);
  fs.writeFileSync(compiler,`import subprocess,sys\nsubprocess.Popen([sys.executable,${JSON.stringify(leaf)},sys.argv[1]]).wait()\n`);
  fs.writeFileSync(entry,`import fs from 'node:fs';import {spawn} from 'node:child_process';import {enterBuildWorkspace} from ${JSON.stringify(moduleFile)};const descriptor=name=>{const i=process.argv.indexOf(name);return i<0?undefined:Number(process.argv[i+1]);};const held=enterBuildWorkspace({directory:${JSON.stringify(workspace)},output:${JSON.stringify(output)},python:${JSON.stringify(python)},entry:process.argv[1],args:[],fd:descriptor('--workspace-fd'),outputFd:descriptor('--output-fd'),manageOutput:true});if(held){const base=process.env.CASE;if(process.env.SECOND){fs.writeFileSync(base+'.second',String(fs.existsSync(base+'.retired')&&!fs.existsSync(${JSON.stringify(path.join(output,'partial'))})));}else{fs.writeFileSync(${JSON.stringify(path.join(output,'partial'))},'partial');fs.writeFileSync(base+'.builder',String(process.pid));spawn(${JSON.stringify(python)},[${JSON.stringify(compiler)},base],{stdio:'inherit'});setInterval(()=>{},1000);}}`);
  const wait=async predicate=>{const deadline=Date.now()+8000;while(!predicate()){assert.ok(Date.now()<deadline,'Timed out waiting for owned process lifetime');await new Promise(resolve=>setTimeout(resolve,20));}};
  for(const target of ['builder','invoker']){
    fs.rmSync(output,{recursive:true,force:true});
    const base=path.join(directory,target),first=spawn(process.execPath,[entry],{env:{...process.env,CASE:base},stdio:['ignore','pipe','pipe']});
    let errors='';first.stderr.on('data',bytes=>errors+=bytes);const finished=once(first,'close');
    t.after(()=>{try{process.kill(-Number(fs.readFileSync(base+'.builder','utf8')),'SIGKILL');}catch{}first.kill('SIGKILL');});
    await wait(()=>fs.existsSync(base+'.leaf'));
    const second=spawn(process.execPath,[entry],{env:{...process.env,CASE:base,SECOND:'1'},stdio:['ignore','pipe','pipe']});
    second.stderr.on('data',bytes=>errors+=bytes);const secondFinished=once(second,'close');t.after(()=>second.kill('SIGKILL'));
    await new Promise(resolve=>setTimeout(resolve,100));assert.equal(fs.existsSync(base+'.second'),false,'Concurrent build stays outside the locked workspace');
    process.kill(target==='builder'?Number(fs.readFileSync(base+'.builder','utf8')):first.pid,'SIGKILL');
    const [status,signal]=await finished;assert.equal(status,null,errors);assert.equal(signal,'SIGKILL',errors);
    const [secondStatus,secondSignal]=await secondFinished;assert.equal(secondStatus,0,errors);assert.equal(secondSignal,null,errors);
    assert.equal(fs.readFileSync(base+'.second','utf8'),'true','Next builder enters only after descendant cleanup');
    const leafPid=Number(fs.readFileSync(base+'.leaf','utf8'));
    assert.throws(()=>process.kill(leafPid,0),error=>error.code==='ESRCH','Compiler descendant is gone when the workspace unlocks');
  }
});
