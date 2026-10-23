import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {adaptPosixHolderProcessGroup} from '../src/modules/android/providers/aim/source.mjs';

const relative='crates/aim-storage/src/posix_broker.rs';
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(command,args,options={}) {
  const r=spawnSync(command,args,{encoding:'utf8',timeout:30000,maxBuffer:2<<20,...options});
  assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);
  assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;
}

test('AIM holder isolation changes only its spawn group and required import',t=>{
  const root=process.env.ANDROID_AIM_POSIX_SOURCE||path.resolve('src/external/aim');
  if(!fs.existsSync(path.join(root,relative)))return t.skip('Requires the pinned AIM source');
  const original=fs.readFileSync(path.join(root,relative),'utf8'),fixed=adaptPosixHolderProcessGroup(original);
  assert.equal(fixed,original.replace('    os::fd::{AsRawFd, FromRawFd},','    os::fd::{AsRawFd, FromRawFd},\n    os::unix::process::CommandExt,').replace('        let mut child = Command::new(&config.holder)\n','        let mut child = Command::new(&config.holder)\n            .process_group(0)\n'));
  assert.throws(()=>adaptPosixHolderProcessGroup(fixed),/no longer matches/);
});

test('actual original POSIX controller preserves lock ownership across group TERM and retires after controller death',{timeout:45000},t=>{
  const inputs=process.env.ANDROID_AIM_POSIX_NATIVE_INPUTS;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!inputs)return t.skip('Requires cached AIM source libraries and the original lock holder');
  const native=JSON.parse(fs.readFileSync(inputs,'utf8'));
  for(const r of native.inputs)assert.equal(sha(r.path),r.sha256,r.path);
  const original=fs.readFileSync(path.join(native.originalSource,relative),'utf8');
  assert.equal(fs.readFileSync(path.join(native.source,relative),'utf8'),adaptPosixHolderProcessGroup(original),'The tested library uses the exact owned adaptation');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aim-posix-lifetime-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const fixture=fileURLToPath(new URL('./fixtures/android-aim-posix/lifetime.rs',import.meta.url));
  const env={...process.env};delete env.DYLD_INSERT_LIBRARIES;delete env.MACLAUNCHER_AIM_IPC_PREFIX;
  for(const[kind,library]of [['original',native.originalStorageLibrary],['adapted',native.storageLibrary]]) {
    const executable=path.join(root,kind),output=path.join(root,kind+'-children');fs.mkdirSync(output);
    const args=['--edition=2024',fixture,'--extern','aim_storage='+library,'--extern','libc='+native.libc,'-C','debuginfo=0','-o',executable];
    for(const directory of native.dependencyDirectories)args.push('-L','dependency='+directory);
    run(native.rustc,args,{env});run('/usr/bin/codesign',['--force','--sign','-',executable],{env});
    try {
      const result=run(executable,[output,native.holder,kind],{env});
      if(kind==='original')assert.match(result,/same: SHUTDOWN errno=Some\(10\)/);
      else {
        assert.match(result,/isolated: SHUTDOWN errno=None/);
        assert.match(result,/orphan_holder=\d+ retired\+real lock released in \d+ms/);
        assert.match(result,/bad: SHUTDOWN errno=Some\(10\)/);
      }
      t.diagnostic(result.trim());
    } finally {run(executable,['cleanup',output],{env});}
  }
});
