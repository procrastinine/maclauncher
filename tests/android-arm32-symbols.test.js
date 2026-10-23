const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('ARM32 original ELF hash tables resolve real relocation groups without scanning every name',{timeout:120000},t=>{
 const build=process.env.ANDROID_ARM32_BUILD,ndk=process.env.ANDROID_NDK_TOOLS;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!ndk)return t.skip('Requires Apple Silicon, native ARM32 component and Android NDK');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-elf-symbols-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(file,args)=>{const r=spawnSync(file,args,{encoding:'utf8',timeout:90000,maxBuffer:2<<20});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const name=i=>'exported_'+String(i).padStart(4,'0');
 const provider=Array.from({length:1024},(_,i)=>`unsigned ${name(i)}(void){return ${i};}`).join('\n')+`
unsigned exported_alias(void) __attribute__((alias("exported_0000")));
unsigned weak_alias(void) __attribute__((weak,alias("exported_0000")));
__attribute__((visibility("hidden"))) unsigned hidden_symbol(void){return 7;}
unsigned version_one(void){return 1;} unsigned version_two(void){return 2;}
__asm__(".symver version_one,versioned_api@VER_1");
__asm__(".symver version_two,versioned_api@@VER_2");
`;
 const consumer=Array.from({length:512},(_,i)=>`extern unsigned ${name(i)}(void);`).join('\n')+'\nvoid *import_pointers[]={'+Array.from({length:512},(_,i)=>name(i)).join(',')+'};\nextern unsigned optional_symbol __attribute__((weak));void *optional_pointer=&optional_symbol;\n';
 fs.writeFileSync(root+'/provider.c',provider);fs.writeFileSync(root+'/consumer.c',consumer);fs.writeFileSync(root+'/versions.map','VER_1 {}; VER_2 {} VER_1;\n');
 const clang=path.join(ndk,'armv7a-linux-androideabi23-clang'),common=['-shared','-nostdlib','-fPIC','-fno-unwind-tables','-fno-exceptions','-fno-stack-protector','-O2'];
 run(clang,[...common,root+'/consumer.c','-Wl,--hash-style=both','-o',root+'/consumer.so']);
 const results=[];
 for(const [label,directory]of[['current',build],...(process.env.ANDROID_ARM32_BASELINE_BUILD?[['baseline',process.env.ANDROID_ARM32_BASELINE_BUILD]]:[])]){
  const library=label==='current'&&process.env.ANDROID_ARM32_LIBRARY||path.resolve(directory,'libandroid-arm32.dylib'),probe=root+'/'+label;
  run('clang++',['-std=c++20','-O2','-Wall','-Wextra','-Werror','-I'+path.resolve('src/modules/android/native/arm32'),path.resolve('tests/fixtures/android-arm32/symbol-lookup.cpp'),path.resolve(library),'-Wl,-rpath,'+path.dirname(path.resolve(library)),...(process.env.ANDROID_ARM32_FRAMEWORKS?['-Wl,-rpath,'+path.resolve(process.env.ANDROID_ARM32_FRAMEWORKS)]:[]),'-o',probe]);
  for(const style of['gnu','sysv','both']){
   const library=root+'/'+style+'.so';if(!fs.existsSync(library))run(clang,[...common,root+'/provider.c','-Wl,--hash-style='+style,'-Wl,--version-script='+root+'/versions.map','-Wl,--defsym=absolute_marker=0x12345','-o',library]);
   const output=run(probe,[library,root+'/consumer.so']);assert.match(output,/PASS original ELF hash layouts/);results.push({label,style,...JSON.parse(output.split('\n').find(line=>line.startsWith('{')))});
  }
 }
 if(process.env.ANDROID_ARM32_BASELINE_BUILD)for(const style of['gnu','sysv','both'])assert.equal(results.find(x=>x.label==='current'&&x.style===style).checksum,results.find(x=>x.label==='baseline'&&x.style===style).checksum);
 t.diagnostic(JSON.stringify(results));
});
