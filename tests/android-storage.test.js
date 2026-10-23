const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {storagePaths,prepareStorage}=require("../src/modules/android/storage");
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),"android-storage-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const userDataDir=path.join(root,"launcher");fs.mkdirSync(userDataDir);return {root,userDataDir,entry:{gameId:"owned-game"}};}
function put(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);}
function published(userDataDir,gameId){
 const root=path.join(userDataDir,"android/apps"),lock=".storage-"+gameId+".lock";
 const stat=fs.lstatSync(path.join(root,lock));assert.ok(stat.isFile()&&!stat.isSymbolicLink());assert.equal(stat.mode&0o077,0);
 return fs.readdirSync(root).filter(name=>name!==lock);
}
test("Android storage migrates one selected app atomically and retains newer saves and originals",async t=>{
 const {userDataDir,entry}=fixture(t),legacy=path.join(userDataDir,"games",entry.gameId,"modules/android");
 put(path.join(legacy,"data/files/save"),"old progress");put(path.join(legacy,"data/no_backup/state"),"state");put(path.join(legacy,"prepared","a".repeat(64),"converted.jar"),"cached conversion");
 const [result,again]=await Promise.all([prepareStorage(entry,userDataDir),prepareStorage(entry,userDataDir)]);
 assert.deepEqual(result,again);assert.deepEqual(result,storagePaths(userDataDir,entry.gameId));
 assert.equal(path.dirname(result.runtimeRoot),result.root);
 assert.ok(path.relative(result.dataRoot,result.runtimeRoot).startsWith('..'+path.sep),'Host session state is outside the original Android data mount');
 assert.equal(fs.readFileSync(path.join(result.filesRoot,"save"),"utf8"),"old progress");
 assert.equal(fs.readFileSync(path.join(result.dataRoot,"no_backup/state"),"utf8"),"state");
 assert.equal(fs.readFileSync(path.join(result.preparedRoot,"a".repeat(64),"converted.jar"),"utf8"),"cached conversion");
 assert.equal(fs.existsSync(path.join(legacy,"prepared")),false);
 put(path.join(result.filesRoot,"save"),"new progress");await prepareStorage(entry,userDataDir);
 assert.equal(fs.readFileSync(path.join(result.filesRoot,"save"),"utf8"),"new progress");
 assert.equal(fs.readFileSync(path.join(legacy,"data/files/save"),"utf8"),"old progress");
 assert.deepEqual(published(userDataDir,entry.gameId),[entry.gameId]);
});
test("Android storage restores a relocated cache if final publication fails",async t=>{
 const {userDataDir,entry}=fixture(t),legacy=path.join(userDataDir,"games",entry.gameId,"modules/android"),paths=storagePaths(userDataDir,entry.gameId);
 put(path.join(legacy,"data/files/save"),"progress");put(path.join(legacy,"prepared/cache/converted.jar"),"cached");
 const rename=fs.promises.rename;
 fs.promises.rename=async(from,to)=>{if(to===paths.root)throw Object.assign(new Error("Owned publication failure"),{code:"EACCES"});return rename(from,to);};
 try{await assert.rejects(prepareStorage(entry,userDataDir),/publication failure/);}finally{fs.promises.rename=rename;}
 assert.equal(fs.readFileSync(path.join(legacy,"prepared/cache/converted.jar"),"utf8"),"cached");
 assert.equal(fs.readFileSync(path.join(legacy,"data/files/save"),"utf8"),"progress");
 assert.equal(fs.existsSync(paths.root),false);assert.deepEqual(published(userDataDir,entry.gameId),[]);
});
test("Android save import keeps the selected original and previous default saves, without later source access",async t=>{
 const {root,userDataDir,entry}=fixture(t),selected=path.join(root,"selected"),legacy=path.join(userDataDir,"games",entry.gameId,"modules/android");
 put(path.join(selected,"save"),"selected");put(path.join(legacy,"data/files/save"),"default");
 entry.saveDirOverride=selected;const result=await prepareStorage(entry,userDataDir);
 assert.equal(fs.readFileSync(path.join(result.filesRoot,"save"),"utf8"),"selected");
 assert.equal(fs.readFileSync(path.join(result.root,"imports/legacy-files/save"),"utf8"),"default");
 assert.equal(fs.readFileSync(path.join(selected,"save"),"utf8"),"selected");
 fs.renameSync(selected,selected+"-moved");await prepareStorage(entry,userDataDir);
 await assert.rejects(prepareStorage({...entry,saveDirOverride:root},userDataDir),/already use private storage/);
});
test("Android storage rejects escaping identities and linked imports without publishing partial data",async t=>{
 const {root,userDataDir,entry}=fixture(t),selected=path.join(root,"selected");
 for(const id of ["../other","a/b","",".","..", "x".repeat(129)])assert.throws(()=>storagePaths(userDataDir,id),/identity/);
 put(path.join(root,"private"),"not selected");fs.mkdirSync(selected);fs.symlinkSync(path.join(root,"private"),path.join(selected,"link"));
 await assert.rejects(prepareStorage({...entry,saveDirOverride:selected},userDataDir),/aliases/);
 assert.equal(fs.existsSync(storagePaths(userDataDir,entry.gameId).root),false);
 assert.deepEqual(published(userDataDir,entry.gameId),[]);
 const controller=new AbortController();controller.abort();await assert.rejects(prepareStorage(entry,userDataDir,{signal:controller.signal}),{name:"AbortError"});
 assert.equal(fs.readFileSync(path.join(root,"private"),"utf8"),"not selected");
});
