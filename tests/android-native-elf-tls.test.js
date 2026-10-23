const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('Original ELF TLS descriptors retain Android TP and physical-thread storage',async t=>{
 const core=process.env.KLEPTON_NATIVE_CORE,clang=process.env.ANDROID_CLANG;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!core||!clang)return t.skip('Requires Apple Silicon, the changed native core and Android Clang');
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'android-elf-tls-'));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const env={...process.env,...(await require('../src/modules/android/process-channel').processNamespace(work,1)).environment};
 const fixture=path.resolve(__dirname,'fixtures/android-native');
 const run=(file,args)=>{const r=spawnSync(file,args,{env,encoding:'utf8',timeout:30000,maxBuffer:2<<20});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const libraries=['dependency','guest'].map(name=>{
  const output=path.join(work,'libtls-'+name+'.so');
  run(clang,['-shared','-nostdlib','-fPIC','-fno-emulated-tls','-fno-stack-protector','-O2','-Wl,--hash-style=both','-Wl,-z,max-page-size=16384',fixture+'/elf-tls-'+name+'.c',...(name==='guest'?[fixture+'/elf-tls-legacy.S']:[]),'-o',output]);return output;
 });
 // Exercise the older general-dynamic ABI that modern LLVM no longer emits.
 // Only these two dynamic relocation records change; code, TLS and the
 // __tls_get_addr PLT import are produced by the ordinary Android toolchain.
 const bytes=fs.readFileSync(libraries[1]),sections=[];
 const table=Number(bytes.readBigUInt64LE(40)),width=bytes.readUInt16LE(58),count=bytes.readUInt16LE(60);
 for(let n=0;n<count;n++){const at=table+n*width;sections.push({type:bytes.readUInt32LE(at+4),offset:Number(bytes.readBigUInt64LE(at+24)),size:Number(bytes.readBigUInt64LE(at+32)),link:bytes.readUInt32LE(at+40)});}
 const dynsym=sections.find(s=>s.type===11),strings=sections[dynsym.link],names=[];
 for(let at=dynsym.offset;at<dynsym.offset+dynsym.size;at+=24){const start=strings.offset+bytes.readUInt32LE(at);names.push(bytes.toString('utf8',start,bytes.indexOf(0,start)));}
 const tls=names.indexOf('tls_initialized');assert(tls>0);let changed=0;
 for(const section of sections.filter(s=>s.type===4&&s.link===sections.indexOf(dynsym)))for(let at=section.offset;at<section.offset+section.size;at+=24){
  const name=names[Number(bytes.readBigUInt64LE(at+8)>>32n)],type=name==='tls_legacy_module_marker'?1028:name==='tls_legacy_offset_marker'?1029:0;
  if(type){bytes.writeBigUInt64LE((BigInt(tls)<<32n)|BigInt(type),at+8);changed++;}
 }
 assert.equal(changed,2);fs.writeFileSync(libraries[1],bytes);
 const binary=path.join(work,'probe');run('clang',['-O2','-Wall','-Wextra','-Werror',fixture+'/elf-tls.c',fixture+'/elf-tls-registers.S','-o',binary]);
 assert.match(run(binary,[path.resolve(core),...libraries]),/PASS ELF TLS initialization, alignment, weak\/external\/hidden symbols, per-thread values and fork preserve the real Android TP/);
});
