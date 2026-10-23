const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test(process.env.ANDROID_GO_STARTUP_ONLY?'Original Android Go CPU initialization agrees with the shared CPU owner':'Original Android Go c-shared runtime exercises its scheduler and allocator through the guest loader',{timeout:30000},t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,library=process.env.ANDROID_GO_RUNTIME_LIBRARY;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!runtime||!library)return t.skip('Requires Apple Silicon, native runtime and the original Android Go c-shared fixture');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-go-runtime-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(file,args,timeout=15000)=>{const r=spawnSync(file,args,{encoding:'utf8',timeout,maxBuffer:4<<20});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const binary=path.join(root,'probe'),ids=path.join(root,'ids');fs.mkdirSync(ids,{mode:0o700});
 run('clang',['-O2','-Wall','-Wextra','-Werror',path.resolve('tests/fixtures/android-native/go-runtime.c'),'-o',binary]);
 const bytes=fs.readFileSync(library),shoff=Number(bytes.readBigUInt64LE(40)),shsize=bytes.readUInt16LE(58),shnum=bytes.readUInt16LE(60),symbols=new Map();
 assert.equal(bytes.subarray(0,5).toString('hex'),'7f454c4602');
 for(let section=0;section<shnum;section++){
  const at=shoff+section*shsize;if(bytes.readUInt32LE(at+4)!==2)continue;
  const table=Number(bytes.readBigUInt64LE(at+24)),size=Number(bytes.readBigUInt64LE(at+32)),stride=Number(bytes.readBigUInt64LE(at+56)),strings=shoff+bytes.readUInt32LE(at+40)*shsize,stringOffset=Number(bytes.readBigUInt64LE(strings+24));
  for(let entry=table;entry<table+size;entry+=stride){const start=stringOffset+bytes.readUInt32LE(entry),name=bytes.subarray(start,bytes.indexOf(0,start)).toString();if(['ProbeGoRuntime','runtime.numCPUStartup','runtime.allgs'].includes(name))symbols.set(name,bytes.readBigUInt64LE(entry+8).toString(16));if(/^_cgoexp_.*_ProbeGoRuntime$/.test(name))symbols.set('callback',bytes.readBigUInt64LE(entry+8).toString(16));}
 }
 const metadata=['ProbeGoRuntime','runtime.numCPUStartup','runtime.allgs'].map(name=>{assert.ok(symbols.has(name),'Original Go metadata '+name);return symbols.get(name);});
 assert.ok(symbols.has('callback'));const callback=BigInt('0x'+symbols.get('callback'));let slot;
 for(let section=0;section<shnum;section++){const at=shoff+section*shsize;if(bytes.readUInt32LE(at+4)!==4)continue;const table=Number(bytes.readBigUInt64LE(at+24)),size=Number(bytes.readBigUInt64LE(at+32)),stride=Number(bytes.readBigUInt64LE(at+56));for(let entry=table;entry<table+size;entry+=stride)if(bytes.readBigInt64LE(entry+16)===callback)slot=bytes.readBigUInt64LE(entry).toString(16);}
 assert.ok(slot,'Original Go callback relocation');metadata.push(symbols.get('callback'),slot);
 const log=path.resolve(process.env.ANDROID_GO_RUNTIME_LOG||path.join(root,'native.log')),fd=fs.openSync(log,'w');let result;
 try{result=spawnSync(binary,[path.resolve(runtime,'native/libklepton-jvm.dylib'),path.resolve(library),ids,...metadata],{timeout:20000,stdio:['ignore',fd,fd]});}finally{fs.closeSync(fd);}
 const output=fs.readFileSync(log,'utf8'),detail=output.length>32768?output.slice(0,16384)+'\n[log excerpt]\n'+output.slice(-16384):output;
 assert.ifError(result.error);assert.equal(result.signal,null,detail);assert.equal(result.status,0,detail);assert.match(output,process.env.ANDROID_GO_STARTUP_ONLY?/PASS original Go CPU initialization:/:/PASS original Android Go shared runtime initialized/);t.diagnostic(detail.trim());
});
