const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
test('physical paste completion crosses the original Android traversal barrier without clipboard access',async t=>{
 if(process.platform!=='darwin')return t.skip('Requires the included macOS Android runtime');
 const runtime=await require('../src/modules/android/runtime').resolveForLaunch();
 const jdk=process.env.MACLAUNCHER_ANDROID_OVERLAY_JDK||'/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home';
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-paste-queue-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const ids=path.join(temporary,'ids');fs.mkdirSync(ids,{mode:0o700});
 const env={...process.env,KL_ANDROID_ID_DIRECTORY:fs.realpathSync(ids)};
 for(const key of Object.keys(env))if(/^(DYLD_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
 const overlay=require('../src/modules/android/text-input').materialize(temporary);
 const classpath=[temporary,overlay,path.join(runtime.root,'android-host.jar'),path.join(runtime.root,'android-framework.jar')].join(path.delimiter);
 function run(command,args){const result=spawnSync(command,args,{env,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;}
 run(path.join(jdk,'bin/javac'),['--release','21','-proc:none','-cp',classpath,'-d',temporary,'tests/fixtures/android-framework-services/TextInputPasteQueueProbe.java']);
 const output=run(path.join(jdk,'bin/java'),[...require('../src/modules/android/jvm-options').frameworkJvmOptions,'-Xverify:all','-cp',classpath,'TextInputPasteQueueProbe',runtime.root,temporary]);
 assert.match(output,/PASS physical paste completion crosses original traversal barrier/);
 assert.equal(fs.statSync(overlay).mode&0o777,0o400);
});
