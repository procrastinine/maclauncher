const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const Python=require("../src/modules/shared/runtime/portable-python");
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),"maclauncher-python-test-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function stagedInputs(t){
  const root=temporary(t),sourceRoot=path.join(root,"source"),buildRoot=path.join(root,"build"),prefix=path.join(root,"prefix");
  for(const dir of ["source/Include","source/Lib/encodings","source/Lib/test","build/build/lib.macosx-13.0-arm64-3.14","build/Modules","prefix"])fs.mkdirSync(path.join(root,dir),{recursive:true});
  fs.writeFileSync(path.join(sourceRoot,"Include/Python.h"),"header");fs.writeFileSync(path.join(sourceRoot,"Lib/encodings/__init__.py"),"encoding");fs.writeFileSync(path.join(sourceRoot,"Lib/test/test_sample.py"),"test");for(const notice of Python.PIN.source.notices){fs.mkdirSync(path.dirname(path.join(sourceRoot,notice)),{recursive:true});fs.writeFileSync(path.join(sourceRoot,notice),"notice");}fs.writeFileSync(path.join(buildRoot,"pyconfig.h"),"config");fs.writeFileSync(path.join(buildRoot,"libpython3.14.dylib"),"library");
  const extensions=path.join(buildRoot,"build/lib.macosx-13.0-arm64-3.14");
  for(const module of ["_struct","math","zlib","unicodedata","_codecs_jp"]){const name=module+".cpython-314-darwin.so";fs.writeFileSync(path.join(buildRoot,"Modules",name),module);fs.symlinkSync("../../Modules/"+name,path.join(extensions,name));}
  fs.writeFileSync(path.join(extensions,"_sysconfigdata__darwin_darwin.py"),JSON.stringify({source:sourceRoot,build:buildRoot,prefix}));
  return{root,sourceRoot,buildRoot,prefix,extensions};
}
test("embedded Python stages actual out-of-tree module links without copying tests or exposing build paths",t=>{
  const input=stagedInputs(t),result=Python.stageRuntime(input);
  assert.equal(result.extensions.length,5);assert.equal(fs.readFileSync(path.join(result.stdlib,"lib-dynload/math.cpython-314-darwin.so"),"utf8"),"math");assert.equal(fs.lstatSync(path.join(result.stdlib,"lib-dynload/math.cpython-314-darwin.so")).isFile(),true);
  assert.equal(fs.existsSync(path.join(result.stdlib,"test")),false);const config=fs.readFileSync(path.join(result.stdlib,"_sysconfigdata__darwin_darwin.py"),"utf8");assert.equal(config.includes(input.root),false);
  assert.equal(fs.readFileSync(path.join(input.buildRoot,"Modules/math.cpython-314-darwin.so"),"utf8"),"math");
});
test("embedded Python refuses extension links leaving the actual compiler output and disabled native modules",t=>{
  const input=stagedInputs(t);const name="math.cpython-314-darwin.so";fs.unlinkSync(path.join(input.extensions,name));const outside=path.join(input.root,"outside");fs.writeFileSync(outside,"outside");fs.symlinkSync(outside,path.join(input.extensions,name));assert.throws(()=>Python.stageRuntime(input),/escaped native module/);assert.equal(fs.readFileSync(outside,"utf8"),"outside");
  const other=stagedInputs(t);fs.writeFileSync(path.join(other.extensions,"_ssl.cpython-314-darwin.so"),"unselected");assert.throws(()=>Python.stageRuntime(other),/unselected/);
});
test("Python compiler uses explicit SDK and ARM13 flags while rejecting shell input and inherited Python overrides",()=>{
  const old=process.env.PYTHONHOME;process.env.PYTHONHOME="unrelated-host-python";try{const env=Python.compilerEnvironment({sdk:"/SDK",sourceRoot:"/tmp/source",workRoot:"/tmp/build"});assert.equal(env.PYTHONHOME,undefined);assert.equal(env.CC,"/usr/bin/clang");assert.match(env.CFLAGS,/-mmacosx-version-min=13\.0/);assert.doesNotMatch(env.CFLAGS,/["']/);assert.equal(env.PATH,"/usr/bin:/bin:/usr/sbin:/sbin");}finally{if(old===undefined)delete process.env.PYTHONHOME;else process.env.PYTHONHOME=old;}
  assert.throws(()=>Python.compilerEnvironment({sdk:"/SDK",sourceRoot:"/tmp/with spaces",workRoot:"/tmp/build"}),/metacharacters or spaces/);
  assert.throws(()=>Python.compilerEnvironment({sdk:"/SDK",sourceRoot:"/tmp/source",workRoot:"/tmp/build",pathMappings:[{from:"/tmp/$(command)",to:"source"}]}),/mappings/);
});
test("cancelled Python build and wrong source bytes create no output",async t=>{
  const root=temporary(t),workRoot=path.join(root,"output");await assert.rejects(Python.buildPython({workRoot,signal:AbortSignal.abort()}),{name:"AbortError"});assert.equal(fs.existsSync(workRoot),false);
  const archive=path.join(root,"archive.tar.xz");fs.writeFileSync(archive,"wrong");assert.throws(()=>Python.validateArchive(archive),/differs/);assert.equal(fs.existsSync(workRoot),false);
});
