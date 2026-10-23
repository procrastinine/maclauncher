const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync,spawnSync}=require('node:child_process');
const {profile,environment}=require('../src/modules/shared/runtime/macos-sandbox');

test('Isolated processes can resume, terminate and reap their own children',{skip:process.platform!=='darwin'},t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-child-signals-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const executable=path.join(root,'probe'),policy=path.join(root,'policy.sb');
 execFileSync('/usr/bin/clang',['-Wall','-Wextra','-Werror','-mmacosx-version-min=13.0',
  path.join(__dirname,'fixtures/network-isolation/owned-child-signals.c'),'-o',executable]);
 fs.writeFileSync(policy,profile({readDirectories:[],readFiles:[],writeDirectories:[],executables:[executable],blockNetwork:true}));
 let result;
 try {
  result=spawnSync('/usr/bin/sandbox-exec',['-f',policy,executable],{
   env:environment(),encoding:'utf8',timeout:5000,detached:true});
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/Owned children resume, terminate and reap/);
 } finally {
  if(result?.pid)try{process.kill(-result.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
 }
});
