const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{execFileSync}=require("node:child_process");

test("Android service binding does not wait for process startup and retains callback/lifetime semantics",t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
  if(process.platform!=="darwin"||!runtime||!home)return t.skip("Requires Java21 and the Android runtime");
  const output=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"android-async-bind-"));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const cp=[output,...["android-host.jar","android-framework.jar"].map(name=>path.resolve(runtime,name))].join(path.delimiter);
  const source="src/modules/android/native/java/maclauncher/android/framework/";
  execFileSync(path.join(home,"bin/javac"),["--release","21","-cp",cp,"-d",output,...["HostProcessServices","HostRemoteServices","HostActivityTasks"].map(name=>source+name+".java"),
    "tests/fixtures/android-process-authority/AsyncServiceBindingProbe.java","tests/fixtures/android-window-session/RuntimeFixture.java"],{stdio:"pipe"});
  const result=execFileSync(path.join(home,"bin/java"),[...require("../src/modules/android/jvm-options").frameworkJvmOptions,"-Xverify:all","-cp",cp,
    "maclauncher.android.framework.AsyncServiceBindingProbe",path.resolve(runtime),output],{encoding:"utf8",timeout:20000,stdio:["ignore","pipe","pipe"],
    env:{...process.env,...require("./helpers/android-java").processNamespace(output)}});
  assert.match(result,/PASS asynchronous service activation, original callbacks, cancellation, death and late-unbind ownership/);
});
