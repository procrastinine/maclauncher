const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const {promisify}=require("node:util"),exec=promisify(require("node:child_process").execFile);
const Storage=require("../src/modules/android/provider-storage"),Policy=require("../src/modules/android/policy");
const {manifest,binaryXml,zip,directory}=require("./helpers/android-packages");

test("upstream providers retain private storage, legacy saves and independent data",async t=>{
 const root=directory(t),entry={gameId:"test-game"};
 const old=path.join(root,"android/apps/test-game/data/files");fs.mkdirSync(old,{recursive:true});fs.writeFileSync(path.join(old,"save"),"original");
 const a=await Storage.prepareStorage(entry,root),b=await Storage.prepareStorage(entry,root,{provider:"aim"});
 assert.notEqual(a.androidRoot,b.androidRoot);assert.equal(fs.readFileSync(path.join(old,"save"),"utf8"),"original");
 assert.throws(()=>Storage.storagePaths(root,"../escape"),/saved game/);
 const link=path.join(root,"android/apps/linked/providers/macapk");fs.mkdirSync(path.dirname(link),{recursive:true});fs.symlinkSync(os.tmpdir(),link);
 await assert.rejects(Storage.prepareStorage({gameId:"linked"},root),/aliases/);
});

test("package publication preserves signed archive bytes and invalidates changed inputs",async t=>{
 const root=directory(t),input=path.join(root,"game.apk"),entry={gameId:"game",gamePath:input};
 const bytes=zip([["AndroidManifest.xml",binaryXml(manifest())],["classes.dex",Buffer.from("original dex")]]);
 fs.writeFileSync(input,bytes);const storage=await Storage.prepareStorage(entry,root),context={userDataDir:root};
 const first=await Storage.preparePackages(entry,context,storage),warm=await Storage.preparePackages(entry,context,storage);
 assert.equal(first.root,warm.root);assert.deepEqual(fs.readFileSync(first.base.file),bytes);
 fs.appendFileSync(input,Buffer.from("changed"));
 await assert.rejects(Storage.preparePackages(entry,context,storage));
 assert.deepEqual(fs.readFileSync(first.base.file),bytes);
});

test("Pixel Tablet profile and network policy default independently of launcher context",()=>{
 const policy=Policy.resolvePolicy();assert.equal(policy.networkAllowed,false);
 assert.equal(policy.device.model,"Pixel Tablet");assert.equal(policy.device.width,2560);assert.equal(policy.device.height,1600);assert.equal(policy.device.densityDpi,320);
 assert.equal(policy.location,null);assert.equal(policy.clipboard,"explicit");
 assert.equal(Policy.resolvePolicy({networkIsolation:false}).networkAllowed,true);
});

test("native processes and descendants cannot read neighboring data or connect offline",{skip:process.platform!=="darwin"},async t=>{
 const root=directory(t),storage=await Storage.prepareStorage({gameId:"native-policy"},root),source=path.join(root,"probe.c"),binary=path.join(root,"probe");
 const secret=path.join(root,"neighbor-secret");fs.writeFileSync(secret,"private");
 fs.writeFileSync(source,'#include <stdio.h>\n#include <fcntl.h>\n#include <errno.h>\n#include <unistd.h>\n#include <sys/socket.h>\n#include <sys/wait.h>\n#include <netinet/in.h>\nint main(int argc,char**argv){int fd=open(argv[1],O_RDONLY);if(fd>=0)return 10;int s=socket(AF_INET,SOCK_STREAM,0);struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(9),.sin_addr.s_addr=htonl(0x7f000001)};if(connect(s,(struct sockaddr*)&a,sizeof a)!=-1||errno!=EPERM)return 11;pid_t p=fork();if(p==0){execl(argv[0],argv[0],argv[1],"child",NULL);_exit(12);}if(argc>2)return 0;int status=0;waitpid(p,&status,0);if(!WIFEXITED(status)||WEXITSTATUS(status))return 13;puts("isolated");return 0;}');
 // Child exits before forking, so the same executable checks inherited policy.
 let text=fs.readFileSync(source,"utf8");text=text.replace('pid_t p=fork();','if(argc>2)return 0;pid_t p=fork();');fs.writeFileSync(source,text);
 await exec("/usr/bin/xcrun",["clang","-O2",source,"-o",binary]);
 const plan=await Policy.prepareIsolation({command:binary,args:[secret],executables:[binary],machServices:["com.apple.nsurlsessiond"]},storage,Policy.resolvePolicy());
 assert.doesNotMatch(plan.profile,/\(global-name "com.apple.nsurlsessiond"\)/);
 const result=await exec(plan.command,plan.args,{env:plan.environment,cwd:storage.root,timeout:10000});assert.equal(result.stdout.trim(),"isolated");
});
