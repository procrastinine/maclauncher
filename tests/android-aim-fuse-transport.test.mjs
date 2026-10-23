import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {adaptFuseTransport,adaptFuseBroker,adaptFuseMountBindings,adaptFuseMountRecords,adaptFuseMountRootTraversal,adaptAimFsTrace,adaptAimFuseTrace} from '../src/modules/android/providers/aim/source.mjs';

test('FUSE transport uses private directory scope and explicit registered descriptor identity',t=>{
 const source=process.env.ANDROID_AIM_FUSE_SOURCE;if(!source)return t.skip('Requires the pinned AIM source');
 const before=fs.readFileSync(path.join(source,'crates/aim-linux-abi/src/sys/fuse.rs'),'utf8'),after=adaptFuseTransport(before);
 assert.ok(after.includes('registered_transport_path(&socket_path(fd, true)?)'));
 assert.ok(after.includes('runtime.join("fuse-sessions").join(allocation)'));
 assert.ok(after.includes('aim_storage::socket_path::in_parent'));
 assert.ok(!after.slice(after.indexOf('fn transport_directory()'),after.indexOf('struct TransportAllocation')).includes('PathBuf::from("/tmp")'));
 assert.equal(after.slice(after.indexOf('fn send_frame('),after.indexOf('// Relative kernel socket addresses')).trimEnd(),before.slice(before.indexOf('fn send_frame(')).trimEnd(),'Original framing and existing tests remain unchanged');
 assert.throws(()=>adaptFuseTransport(after),/no longer matches/);
 const broker=fs.readFileSync(path.join(source,'crates/aim-linux-abi/src/sys/fuse/broker.rs'),'utf8'),adapted=adaptFuseBroker(broker);
 assert.ok(adapted.includes('key: SessionKey(path.to_owned())'));
 assert.ok(adapted.includes('libc::poll(&mut event, 1, 2)'));
 assert.ok(!adapted.includes('std::thread::sleep(Duration::from_millis(2));'));
 assert.throws(()=>adaptFuseBroker(adapted),/no longer matches/);
 const vfs=fs.readFileSync(path.join(source,'crates/aim-linux-abi/src/vfs.rs'),'utf8'),bound=adaptFuseMountBindings(vfs);
 assert.ok(bound.includes('if let Some(id) = mount_namespace_id() { namespace_mount_points(&id)?; }'));
 assert.ok(bound.includes('Some(child.guest),'));
 assert.throws(()=>adaptFuseMountBindings(bound),/no longer matches/);
 const traversal=adaptFuseMountRootTraversal(bound);assert.ok(traversal.includes('if route.relative.is_empty() { continue; }'));
 assert.throws(()=>adaptFuseMountRootTraversal(traversal),/no longer matches/);
 const records=fs.readFileSync(path.join(source,'crates/aim-storage/src/mount_namespace/records.rs'),'utf8'),recorded=adaptFuseMountRecords(records);
 assert.ok(recorded.includes('Some(mount.id) != destination'));
 assert.throws(()=>adaptFuseMountRecords(recorded),/no longer matches/);
 const fsops=adaptAimFsTrace(fs.readFileSync(path.join(source,'crates/aim-linux-abi/src/sys/fsops.rs'),'utf8'));
 assert.ok(fsops.includes('MACLAUNCHER_AIM_FS_TRACE'));assert.ok(fsops.includes('*libc::__error() = saved'));
 assert.throws(()=>adaptAimFsTrace(fsops),/no longer matches/);
 const client=adaptAimFuseTrace(fs.readFileSync(path.join(source,'crates/aim-linux-abi/src/sys/fuse_client.rs'),'utf8'));
 assert.ok(client.includes('op=fuse-lookup-negative'));assert.ok(client.includes('op=fuse-getattr'));
});

test('broker readiness preserves original metadata requests and notifications',{timeout:20000},t=>{
 const executable=process.env.ANDROID_AIM_FUSE_NATIVE_EXECUTABLE;if(!executable)return t.skip('Requires the compiled original AIM native module');
 const metricsFile=process.env.ANDROID_AIM_FUSE_READINESS_RESULT;assert.ok(metricsFile,'Requires an owned metrics output path');if(fs.existsSync(metricsFile))fs.unlinkSync(metricsFile);
 const result=spawnSync(executable,['--exact','sys::fuse::tests::maclauncher_private_fuse::broker_readiness_preserves_metadata_requests_and_notifications','--nocapture','--test-threads=1'],{encoding:'utf8',timeout:15000,maxBuffer:2<<20});
 assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);
 const metrics=JSON.parse(fs.readFileSync(metricsFile));assert.deepEqual([metrics.cycles,metrics.lookup,metrics.getattr,metrics.forget],[32,35,33,33]);
 assert.match(result.stdout,/1 passed; 0 failed; 0 ignored/);t.diagnostic(JSON.stringify(metrics));t.diagnostic(result.stdout.trim());
});

test('original recursive VFS bind preserves late child propagation',{timeout:20000},t=>{
 const executable=process.env.ANDROID_AIM_FUSE_BIND_EXECUTABLE;if(!executable)return t.skip('Requires the compiled original AIM VFS module');
 const result=spawnSync(executable,['vfs::maclauncher_fuse_bind::','--nocapture','--test-threads=1'],{encoding:'utf8',timeout:15000,maxBuffer:2<<20});
 assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stdout,/recursive_copy_retains_late_child_mount_identity \.\.\. ok/);
 assert.match(result.stdout,/self_recursive_copy_retains_the_previous_child_mount_object \.\.\. ok/);
 assert.match(result.stdout,/2 passed; 0 failed; 0 ignored/);t.diagnostic(result.stdout.trim());
});

test('original guest syscalls cross mounted lower data after FUSE ancestors',{timeout:40000},t=>{
 const executable=process.env.ANDROID_AIM_FUSE_WALK_EXECUTABLE;if(!executable)return t.skip('Requires the compiled original AIM FUSE path walker');
 for(const trace of [false,true]){
  const env={...process.env};if(trace)env.MACLAUNCHER_AIM_FS_TRACE='1';else delete env.MACLAUNCHER_AIM_FS_TRACE;
  const result=spawnSync(executable,['--exact','sys::fuse::tests::maclauncher_private_fuse::path_walk::original_syscalls_cross_late_lower_mount_after_fuse_ancestors','--nocapture','--test-threads=1'],{env,encoding:'utf8',timeout:15000,maxBuffer:2<<20});
  assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/1 passed; 0 failed; 0 ignored/);
  if(trace){
   assert.match(result.stderr,/\[aim-fs-trace-enabled\] host_pid=\d+ limit=64/);
   assert.match(result.stderr,/op=mkdir .*result=-17/);assert.match(result.stderr,/op=mkdir phase=resolve result=-2/);
   assert.match(result.stderr,/op=resolve-w guest=.*missing-child.*result=-2/);
   assert.match(result.stderr,/op=fuse-lookup-negative .*result=-2/);assert.match(result.stderr,/op=fuse-getattr .*result=-2/);
   assert.match(result.stderr,/euid=10213 egid=10213 fsuid=10213 fsgid=10213 groups=\[1078\]/);
   const lines=result.stderr.split('\n').filter(x=>x.startsWith('[aim-fs-trace]'));assert.equal(lines.length,64);assert.ok(lines.every(x=>x.length<2600));assert.match(result.stderr,/<truncated>/);
  }else assert.doesNotMatch(result.stderr,/\[aim-fs-trace/);
  t.diagnostic(`trace=${trace}: ${result.stdout.trim()}`);
 }
});

test('complete original native FUSE module preserves the private transport protocol',{timeout:30000},t=>{
 const executable=process.env.ANDROID_AIM_FUSE_NATIVE_EXECUTABLE;if(!executable)return t.skip('Requires the compiled original AIM native module');
 const result=spawnSync(executable,['--exact','sys::fuse::tests::maclauncher_private_fuse::private_transport_keeps_original_protocol_and_descriptor_identity','--nocapture','--test-threads=1'],{encoding:'utf8',timeout:25000,maxBuffer:2<<20});
 assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);
 // The original isolated-kernel wrapper retains its child's output on failure.
 assert.match(result.stdout,/private_transport_keeps_original_protocol_and_descriptor_identity \.\.\. ok/);
 assert.match(result.stdout,/1 passed; 0 failed; 0 ignored/);t.diagnostic(result.stdout.trim());
});
