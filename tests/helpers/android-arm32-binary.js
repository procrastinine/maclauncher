const fs=require('node:fs'),path=require('node:path');

// LLVM resolves a fixture completely before execution. The translator receives
// only flat bytes and an explicit entry table, never a private ELF loader.
function linkBinary(run,linker,objects,exports,imports,output){
 const script=output+'.ld';
 const definitions=imports.map((name,index)=>`${name} = 0x${(0x21000000+index*16).toString(16)};`).join('\n');
 fs.writeFileSync(script,definitions+`\nSECTIONS {
  . = 0x10000000;
  .entries : { ${exports.map(name=>`LONG(${name});`).join(' ')} }
  .text : { *(.text*) }
  .rodata : { *(.rodata*) }
  .data : { *(.data*) *(.bss*) *(COMMON) BYTE(0); }
  /DISCARD/ : { *(.ARM.exidx*) *(.ARM.extab*) *(.comment*) *(.note*) }
 }\n`);
 fs.writeFileSync(path.join(path.dirname(output),'fixture-entries.h'),exports.map((name,index)=>`#define ENTRY_${name} ${index}`).join('\n')+'\n');
 run(linker,['-flavor','gnu','-T',script,'--oformat=binary','-o',output,...objects]);
}
module.exports={linkBinary};
