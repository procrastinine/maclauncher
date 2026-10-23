const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');

test('an ELF entry survives original-style local version rules without entering shared stub exports',t=>{
 const compiler=process.env.ANDROID_CLANG;
 if(!compiler)return t.skip('Requires the selected Android Clang');
 const linker=process.env.ANDROID_ELF_LINKER||path.join(path.dirname(compiler),'ld.lld');
 const readobj=process.env.LLVM_READOBJ||path.join(path.dirname(compiler),'llvm-readobj');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-linker-entry-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const map=path.join(root,'original.map'),original='ANDROID_1 { global: __loader_fixture; local: *; };\n';
 fs.writeFileSync(map,original);
 const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',timeout:15000,maxBuffer:1<<20});
 const scalar=value=>typeof value==='object'?value.Value:value;
 for(const [abi,target,flags]of [['arm64','aarch64-linux-android35',[]],['arm','armv7a-linux-androideabi35',['-mthumb']]]){
  const source=path.join(root,abi+'.c'),object=source+'.o',image=source+'.so',stub=path.join(root,abi+'-stub.c');
  fs.writeFileSync(source,'int __loader_fixture(void){return 1;}\nunsigned long klj_linker_initialize(void *args){return (unsigned long)args+7;}\nint unused_bootstrap_helper(void){return 11;}\n');
  run(compiler,['--target='+target,'-x','c','-ffreestanding','-fPIC','-ffunction-sections','-fdata-sections','-fno-stack-protector',...flags,'-c',source,'-o',object]);
  const linkFlags=['-shared','--gc-sections','--no-undefined','--no-undefined-version','--fatal-warnings','--version-script='+map];
  run(linker,[...linkFlags,'--entry=klj_linker_initialize',object,'-o',image]);
  const record=JSON.parse(run(readobj,['--elf-output-style=JSON','--file-header','--symbols','--dyn-symbols',image]))[0];
  const symbols=record.Symbols.map(row=>row.Symbol),entry=symbols.find(row=>row.Name.Name==='klj_linker_initialize');
  assert.ok(entry,'entry section survives --gc-sections');
  assert.equal(entry.Binding.Name,'Local','unchanged script localizes the owned entry');
  assert.equal(BigInt(scalar(record.ElfHeader.Entry)),BigInt(scalar(entry.Value)),'ELF e_entry is the retained localized function address');
  assert.notEqual(BigInt(scalar(entry.Value)),0n);
  assert.ok(!record.DynamicSymbols.some(row=>row.Symbol.Name.Name==='klj_linker_initialize'),'bootstrap is not a dynamic loader API');
  assert.ok(!symbols.some(row=>row.Name.Name==='unused_bootstrap_helper'),'unused local function is actually garbage collected');
  fs.writeFileSync(stub,'int __loader_fixture(void){return 1;}\n');
  run(compiler,['--target='+target,'-x','c','-ffreestanding','-fPIC','-ffunction-sections',...flags,'-c',stub,'-o',stub+'.o']);
  run(linker,[...linkFlags,stub+'.o','-o',stub+'.so']);
  assert.equal(fs.readFileSync(map,'utf8'),original,'the same strict map also links a stub without the bootstrap');
 }
});
