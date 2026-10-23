const test=require('node:test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {prepareProcessQuerySpawn}=require('../src/modules/android/process-channel');

const program=`
const net=require('node:net'),socket=new net.Socket({fd:Number(process.env.KL_ANDROID_PROCESS_QUERY_FD),readable:true,writable:true});
let bytes=Buffer.alloc(0),printed=false;
socket.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);if(bytes.length<4)return;const size=bytes.readUInt32BE();
 if(size===0xffffffff){printed=true;console.log(JSON.stringify({fallback:true}));socket.destroy();}
 else if(bytes.length>=4+size*4){printed=true;console.log(JSON.stringify({pids:Array.from({length:size},(_,i)=>bytes.readUInt32BE(4+i*4))}));socket.destroy();}});
socket.on('close',()=>{if(!printed)console.log(JSON.stringify({closed:true}));});socket.on('error',()=>{});
socket.write(process.env.BAD_QUERY?'not a namespace path':Buffer.from([1]));
if(process.env.EARLY_EXIT)setTimeout(()=>process.exit(0),100);`;

async function run(query,extra={}){
 const options={env:{...process.env,KL_ANDROID_ID_DIRECTORY:'/sealed/profile/process-ids',...extra},stdio:['ignore','pipe','pipe']};
 const capability=prepareProcessQuerySpawn(options,'/sealed/runtime/supervisor',{query});
 assert.deepEqual(options.stdio,['ignore','pipe','pipe'],'Existing descriptors stay unchanged');
 const child=spawn(process.execPath,['-e',program],capability.options);capability.attach(child);
 let output='',detail='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>detail+=bytes);
 const [code]=await once(child,'close');assert.equal(code,0,detail);return output?JSON.parse(output):undefined;
}

test('process query capability seals scope, validates candidates and preserves native fallback',{timeout:10000},async()=>{
 let calls=0;
 const value=await run(async(helper,args,descriptor,options)=>{
  calls++;assert.equal(helper,'/sealed/runtime/supervisor');assert.deepEqual(args,['--namespace-processes','/sealed/profile/process-ids']);
  assert.equal(descriptor,undefined);assert.ok(options.signal instanceof AbortSignal);return {pids:[41,43,41]};
 });
 assert.deepEqual(value,{pids:[41,43]});assert.equal(calls,1);
 assert.deepEqual(await run(async()=>{throw Error('Snapshot unavailable');}),{fallback:true});
 assert.deepEqual(await run(async()=>({pids:[-1]})),{fallback:true});
 assert.deepEqual(await run(async()=>{throw Error('Malformed input must not dispatch');},{BAD_QUERY:'1'}),{closed:true});
});

test('retiring a process cancels its outstanding namespace query',{timeout:10000},async()=>{
 let cancellation;
 const value=await run(async(helper,args,descriptor,{signal})=>{
  cancellation=signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 },{EARLY_EXIT:'1'});
 assert.equal(value,undefined);assert.equal(cancellation.aborted,true);
});
