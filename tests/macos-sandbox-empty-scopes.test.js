const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync,spawnSync}=require('node:child_process');
const {profile,environment}=require('../src/modules/shared/runtime/macos-sandbox');

test('Empty filesystem and executable scopes grant no global authority',{skip:process.platform!=='darwin'},t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'empty-sandbox-scopes-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const executable=path.join(root,'probe'),canary=path.join(root,'private.canary');
 execFileSync('/usr/bin/clang',['-Wall','-Wextra','-Werror','-mmacosx-version-min=13.0',
  path.join(__dirname,'fixtures/network-isolation/empty-scopes.c'),'-o',executable]);
 fs.writeFileSync(canary,'private');
 const policy=path.join(root,'policy.sb');
 fs.writeFileSync(policy,profile({readDirectories:[],readFiles:[],writeDirectories:[],executables:[executable],blockNetwork:true}));
 const restricted=spawnSync('/usr/bin/sandbox-exec',['-f',policy,executable,canary],{env:environment(),encoding:'utf8',timeout:5000});
 assert.ifError(restricted.error);assert.equal(restricted.status,0,restricted.stdout+restricted.stderr);
 assert.match(restricted.stdout,/Empty write scopes preserve file isolation/);
 fs.writeFileSync(policy,profile({readDirectories:[],readFiles:[executable],writeDirectories:[],executables:[],blockNetwork:true}));
 const noExecution=spawnSync('/usr/bin/sandbox-exec',['-f',policy,executable,canary],{env:environment(),encoding:'utf8',timeout:5000});
 assert.ifError(noExecution.error);assert.notEqual(noExecution.status,0);
 assert.match(noExecution.stderr,/Operation not permitted|Permission denied/);
 assert.equal(fs.readFileSync(canary,'utf8'),'private');
});
