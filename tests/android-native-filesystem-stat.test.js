const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
test('filesystem-stat descriptor family reuses the path converter and original Linux record layout',async t=>{
 const klepton=process.env.KLEPTON_SOURCE,runtime=process.env.KLEPTON_NATIVE_RUNTIME,declarations=process.env.ANDROID_IMPORT_DECLARATIONS;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!klepton||!runtime||!declarations)return t.skip('Requires Apple Silicon and the original native build inputs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-filesystem-stat-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const files={shim:'kl_shim.c',slink:'kl_libc_slink.c',libc:'kl_libc.c'};for(const [key,file]of Object.entries(files)){const target=path.join(root,file);fs.copyFileSync(path.join(klepton,'runtime/libc',file),target);files[key]=target;}
 const {prepareIoSources}=await import('../src/modules/android/native/io-sources.mjs');prepareIoSources(files);
 const source=fs.readFileSync(files.libc,'utf8');fs.writeFileSync(path.join(root,'statfs-unit.c'),source.slice(source.indexOf('typedef struct {\n    uint64_t f_type'),source.indexOf('// ---------- getrandom ----------')));
 const ast=JSON.parse(fs.readFileSync(path.join(declarations,'host-ast.json'))),record=ast.types['struct statfs'];
 fs.writeFileSync(path.join(root,'statfs-layout.h'),'_Static_assert(sizeof(bionic_statfs)=='+record.size+',"Original NDK statfs size");\n'+record.fields.map(f=>'_Static_assert(offsetof(bionic_statfs,'+f.name+')=='+f.offset/8+',"Original NDK '+f.name+'");').join('\n'));
 const shim=fs.readFileSync(files.shim,'utf8');for(const name of ['statfs','statfs64','fstatfs','fstatfs64','statvfs','statvfs64','fstatvfs','fstatvfs64','posix_fadvise','posix_fadvise64'])assert.match(shim,new RegExp('E\\("'+name+'", klb_'));
 const core=path.resolve(runtime,'native/libklepton-jvm.dylib'),probe=path.join(root,'probe');
 const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',timeout:15000,maxBuffer:1<<20});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run('clang',['-std=gnu11','-Wall','-Wextra','-Werror','-I'+root,path.resolve('tests/fixtures/android-native/filesystem-stat.c'),core,'-Wl,-rpath,'+path.dirname(core),'-o',probe]);
 assert.match(run(probe,[root]),/PASS original filesystem-stat records, descriptor lifetime and advisory errors/);
 if(process.env.ANDROID_FILESYSTEM_STAT_LIBRARY)assert.match(run(probe,[root,path.resolve(process.env.ANDROID_FILESYSTEM_STAT_LIBRARY)]),/PASS original filesystem-stat records, descriptor lifetime and advisory errors/);
});
