const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');

test('Rust remaps share native source identities and preserve Cargo flag precedence',async t=>{
 const {nativePathMappings,nativePathFlags,nativeRustPathEnvironment}=await import('../src/modules/android/native/upstream/native-paths.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android Rust source '));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),alias=path.join(root,'alias');fs.mkdirSync(source);fs.symlinkSync(source,alias);
 const options={source:alias,build:path.join(root,'build')};
 const mappings=nativePathMappings(options),flags=nativePathFlags(options);
 for(const [from,to]of mappings)assert.ok(flags.includes('-ffile-prefix-map='+from+'='+to));
 assert.ok(mappings.some(([from,to])=>from===fs.realpathSync(source)&&to==='/src/upstream'));
 const original={RUSTFLAGS:'-C opt-level=2',CARGO_ENCODED_RUSTFLAGS:'--cfg\x1ffeature="path with spaces"'};
 const encoded=nativeRustPathEnvironment(options,original).CARGO_ENCODED_RUSTFLAGS.split('\x1f');
 assert.deepEqual(encoded.slice(0,2),['--cfg','feature="path with spaces"']);
 assert.ok(!encoded.includes('opt-level=2'));
 assert.deepEqual(original,{RUSTFLAGS:'-C opt-level=2',CARGO_ENCODED_RUSTFLAGS:'--cfg\x1ffeature="path with spaces"'});
 assert.deepEqual(nativeRustPathEnvironment(options,{RUSTFLAGS:'-C opt-level=2'}).CARGO_ENCODED_RUSTFLAGS.split('\x1f').slice(0,2),['-C','opt-level=2']);
 assert.ok(encoded.includes('--remap-path-prefix='+alias+'=/src/upstream'));
});

test('Rust object file and debug records omit private source/build directories',async t=>{
 const compiler=process.env.ANDROID_RUSTC;if(!compiler)return t.skip('Requires the selected Rust compiler');
 const {nativeRustPathEnvironment}=await import('../src/modules/android/native/upstream/native-paths.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android Rust artifact '));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),build=path.join(root,'build');fs.mkdirSync(source);fs.mkdirSync(build);
 const input=path.join(source,'probe.rs'),object=path.join(build,'probe.o');
 fs.writeFileSync(input,'#[no_mangle]\npub extern "C" fn source_path() -> *const u8 { concat!(file!(), "\\0").as_ptr() }\n');
 const flags=nativeRustPathEnvironment({source,build},{}).CARGO_ENCODED_RUSTFLAGS.split('\x1f');
 execFileSync(compiler,['--edition=2021','--crate-type=lib','--emit=obj','-g',...flags,input,'-o',object],{cwd:build,stdio:'pipe'});
 const bytes=fs.readFileSync(object);
 assert.ok(bytes.includes(Buffer.from('/src/upstream/probe.rs')));
 for(const directory of [root,fs.realpathSync(root)])assert.ok(!bytes.includes(Buffer.from(directory)),'Private source/build path remained in Rust output');
});

test('ARM32 CMake flag transport remaps C, C++ and assembly with spaced paths',async t=>{
 if(process.platform!=='darwin')return t.skip('Requires Apple Clang assembly syntax');
 const {nativePathFlags,nativeFlagsString}=await import('../src/modules/android/native/upstream/native-paths.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android native artifact '));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),build=path.join(root,'build');fs.mkdirSync(source);
 fs.writeFileSync(path.join(source,'CMakeLists.txt'),'cmake_minimum_required(VERSION 3.20)\nproject(path_probe C CXX ASM)\nadd_library(path_probe OBJECT probe.c probe.cpp probe.S)\n');
 fs.writeFileSync(path.join(source,'probe.c'),'const char *c_source(void){return __FILE__;}\n');
 fs.writeFileSync(path.join(source,'probe.cpp'),'extern "C" const char *cpp_source(){return __FILE__;}\n');
 fs.writeFileSync(path.join(source,'probe.S'),'.section __TEXT,__const\n.asciz __FILE__\n');
 const flags=nativeFlagsString(['-g',...nativePathFlags({source,build})]);
 execFileSync('cmake',['-S',source,'-B',build,...['C','CXX','ASM'].map(language=>'-DCMAKE_'+language+'_FLAGS='+flags)],{stdio:'pipe'});
 execFileSync('cmake',['--build',build,'--parallel','3'],{stdio:'pipe'});
 for(const file of ['probe.c.o','probe.cpp.o','probe.S.o']){
  const bytes=fs.readFileSync(path.join(build,'CMakeFiles/path_probe.dir',file));
  assert.ok(bytes.includes(Buffer.from('/src/upstream/probe.')));
  for(const directory of [root,fs.realpathSync(root)])assert.ok(!bytes.includes(Buffer.from(directory)),file+' retained a private path');
 }
});
