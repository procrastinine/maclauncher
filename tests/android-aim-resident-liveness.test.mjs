import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {adaptResidentProcessLiveness,adaptResidentWorkerDrain} from '../src/modules/android/providers/aim/source.mjs';

const relative='crates/aimctl/src/resident.rs';
const run=(command,args,options={})=>{
 const result=spawnSync(command,args,{encoding:'utf8',timeout:30000,maxBuffer:2<<20,...options});
 assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);
 assert.equal(result.status,0,result.stdout+result.stderr);return result;
};

test('resident liveness changes only the kernel zombie condition',t=>{
 const source=process.env.ANDROID_AIM_RESIDENT_SOURCE;
 if(!source)return t.skip('Requires the existing AIM source projection');
 const original=fs.readFileSync(path.join(source,relative),'utf8');
 const adapted=adaptResidentProcessLiveness(original);
 const before='    Ok(process_info(process.host_pid)?.is_some_and(|info| info_identity(&info) == process))';
 const after='    Ok(process_info(process.host_pid)?.is_some_and(|info| {\n        info.pbi_status != libc::SZOMB && info_identity(&info) == process\n    }))';
 assert.equal(adapted,original.replace(before,after));
 assert.equal(adapted.replace(after,before),original,'Metadata errors, exact birth checks and ancestry/signal authority are preserved');
 assert.throws(()=>adaptResidentProcessLiveness(adapted),/no longer matches/);
});

test('registered worker drain uses the existing finish budget without changing signal authority',t=>{
 const source=process.env.ANDROID_AIM_RESIDENT_SOURCE;if(!source)return t.skip('Requires the existing AIM source projection');
 const original=fs.readFileSync(path.join(source,relative),'utf8'),adapted=adaptResidentWorkerDrain(original);
 assert.ok(adapted.includes('let workers = wait_registered_workers_ended(files, deadline);'));
 assert.equal(adapted.slice(adapted.indexOf('fn process_info')),original.slice(original.indexOf('fn process_info')),'All kernel metadata, identity, ancestry and signal code is unchanged');
 assert.throws(()=>adaptResidentWorkerDrain(adapted),/no longer matches/);
});

test('actual resident code recognizes a real unreaped zombie as ended',{timeout:45000},t=>{
 const source=process.env.ANDROID_AIM_RESIDENT_SOURCE,inputs=process.env.ANDROID_AIM_RESIDENT_NATIVE_INPUTS;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!source||!inputs)
  return t.skip('Requires AIM source and cached native compiler inputs');
 const native=JSON.parse(fs.readFileSync(inputs,'utf8'));
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-aim-resident-'));
 t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const directory=path.join(temporary,'src');
 fs.cpSync(path.join(source,'crates/aimctl/src'),directory,{recursive:true});
 const resident=path.join(directory,'resident.rs');
 const original=fs.readFileSync(resident,'utf8');
 fs.writeFileSync(resident,adaptResidentWorkerDrain(adaptResidentProcessLiveness(original))+'\n#[cfg(test)]\n#[path='+JSON.stringify(fileURLToPath(new URL('./fixtures/android-aim-resident/liveness.rs',import.meta.url)))+']\nmod liveness_regression_fixture;\n');
 const executable=path.join(temporary,'resident-liveness');
 const args=['--edition=2024','--crate-name','aimctl','--test',path.join(directory,'main.rs'),'-C','opt-level=1','-C','debuginfo=0','-o',executable];
 for(const directory of native.dependencyDirectories)args.push('-L','dependency='+directory);
 for(const[name,file]of Object.entries(native.externs))args.push('--extern',name+'='+file);
 run(native.rustc,args);
 const result=run(executable,['resident::liveness_regression_fixture','--nocapture','--test-threads=1']);
 assert.match(result.stdout,/3 passed; 0 failed/);
 assert.match(result.stdout,/actual resident: live birth retained, stale birth cannot signal, unreaped SZOMB ended, registry errors retained/);
 assert.match(result.stdout,/actual resident drain: real guest reaped first; exact registered worker exits later; observed without signals/);
 assert.match(result.stdout,/actual resident drain: live deadline keeps error; malformed registry fails immediately; reused birth remains untouched/);
 t.diagnostic(result.stdout.trim());
});
