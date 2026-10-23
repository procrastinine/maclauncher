const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('Native ABI families precede actual generic tables and retain the guest page contract',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,forward=process.env.ANDROID_NATIVE_FORWARD_TABLE;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!runtime||!forward)return t.skip('Requires Apple Silicon, a built runtime and its generated generic native table');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-page-contract-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(file,args)=>{const r=spawnSync(file,args,{encoding:'utf8',timeout:15000,maxBuffer:8<<20});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const core=path.resolve(runtime,'native/libklepton-jvm.dylib'),binary=path.join(root,'probe'),plan=path.join(root,'owners');
 const owned=fs.readFileSync(path.resolve('src/modules/android/native/native-libc-imports.h'),'utf8');
 const generic=new Set([...fs.readFileSync(forward,'utf8').matchAll(/^\s*KL_FWD\((\w+)\)/gm)].map(m=>m[1]));
 const symbols=new Map([...run('nm',['-an',core]).matchAll(/^([0-9a-fA-F]+)\s+[tTdDbBsS]\s+_(\w+)$/gm)].map(m=>[m[2],BigInt('0x'+m[1])]));
 const textAddress=/segname __TEXT\s+vmaddr (0x[0-9a-f]+)/.exec(run('otool',['-l',core]));assert.ok(textAddress);const preferred=BigInt(textAddress[1]);
 const collisions=[...owned.matchAll(/KLJ_LIBC\("([^"]+)",\s*&?(\w+)\)/g)].filter(m=>generic.has(m[1]));assert.ok(collisions.length>0);
 fs.writeFileSync(plan,collisions.map(([,name,target])=>name+' '+target+' '+(symbols.has(target)?symbols.get(target)-preferred:0xffffffffffffffffn).toString(16)).join('\n')+'\n');
 run('clang',['-O2','-Wall','-Wextra','-Werror',path.resolve('tests/fixtures/android-native/page-contract.c'),'-o',binary]);
 if(process.env.ANDROID_PAGE_BASELINE)t.diagnostic('Baseline '+run(binary,[path.resolve(process.env.ANDROID_PAGE_BASELINE,'native/libklepton-jvm.dylib'),plan,'observe']).trim());
 const result=run(binary,[core,plan,'verify']);assert.match(result,/PASS\d+ programmatically discovered native ABI\/generic table collisions/);assert.match(result,/PASS advertised page size, original Go mincore discovery/);t.diagnostic(result.trim());
});
