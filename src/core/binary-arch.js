'use strict';
const fs = require('node:fs');
const MACH = new Map([[7, 'i386'], [0x1000007, 'x86_64'], [12, 'arm'], [0x100000c, 'arm64']]);
const PE = new Map([[0x14c, 'i386'], [0x8664, 'x86_64'], [0xaa64, 'arm64'], [0xa641, 'arm64ec'], [0xa64e, 'arm64x']]);
const ELF = new Map([[3, 'x86'], [62, 'x86_64'], [183, 'aarch64'], [40, 'arm']]);
function fail(message) { throw new Error(`Invalid binary: ${message}`); }
function safe(value) { if (typeof value === 'bigint') { if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('offset too large'); value = Number(value); } return value; }
function reader(size, read) {
  return { size, get(offset, length) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > size - offset) fail('header or data outside file bounds');
    if (length > 16 * 1024 * 1024) fail('metadata too large');
    return read(offset, length);
  } };
}
function macho(r, base = 0, size = r.size) {
  const first = r.get(base, 4).readUInt32BE(0);
  const thin = new Map([[0xfeedface,['BE',28]],[0xcefaedfe,['LE',28]],[0xfeedfacf,['BE',32]],[0xcffaedfe,['LE',32]]]).get(first);
  if (thin) {
    if (size < thin[1]) fail('Mach-O header outside slice bounds');
    const b = r.get(base, thin[1]), cpu = b[`readUInt32${thin[0]}`](4);
    const commandCount = b[`readUInt32${thin[0]}`](16), commands = b[`readUInt32${thin[0]}`](20);
    if (commands > size - thin[1] || commandCount > commands / 8) fail('Mach-O load commands outside slice bounds');
    let cursor = 0;
    for (let i = 0; i < commandCount; i++) {
      if (commands - cursor < 8) fail('Mach-O command outside load-command bounds');
      const command = r.get(base + thin[1] + cursor, 8), length = command[`readUInt32${thin[0]}`](4);
      if (length < 8 || length > commands - cursor) fail('Mach-O command outside load-command bounds');
      cursor += length;
    }
    const architecture = MACH.get(cpu); if (!architecture) fail(`unsupported Mach-O CPU ${cpu}`);
    return { format: 'macho', architectures: [architecture], slices: [{ architecture, offset: base, size, endian: thin[0].toLowerCase() }] };
  }
  const fat = new Map([[0xcafebabe,['BE',20]],[0xbebafeca,['LE',20]],[0xcafebabf,['BE',32]],[0xbfbafeca,['LE',32]]]).get(first);
  if (!fat || base) fail('unsupported Mach-O header');
  const count = r.get(4,4)[`readUInt32${fat[0]}`](0);
  if (!count || count > 128) fail('invalid Mach-O slice count');
  const table = r.get(8,count*fat[1]), slices = [];
  for (let i=0; i<count; i++) {
    const o=i*fat[1], u32=p=>table[`readUInt32${fat[0]}`](o+p), u64=p=>safe(table[`readBigUInt64${fat[0]}`](o+p));
    const offset=fat[1]===32?u64(8):u32(8), length=fat[1]===32?u64(16):u32(12);
    if (offset < 8+table.length || length > r.size-offset || slices.some(s=>offset<s.offset+s.size && s.offset<offset+length)) fail('Mach-O slice outside bounds or overlapping');
    const inner=macho(r,offset,length);
    if (inner.architectures[0] !== MACH.get(u32(0))) fail('Mach-O slice CPU differs from fat header');
    slices.push(...inner.slices);
  }
  return { format:'macho', architectures:[...new Set(slices.map(s=>s.architecture))], slices };
}
function pe(r) {
  const dos=r.get(0,64), start=dos.readUInt32LE(60), coff=r.get(start,24);
  if (coff.readUInt32LE(0)!==0x4550) fail('missing PE signature');
  const machineCode=coff.readUInt16LE(4), declared=PE.get(machineCode), count=coff.readUInt16LE(6), length=coff.readUInt16LE(20);
  if (!declared || !count || count>4096) fail('unsupported PE machine or section count');
  const optional=r.get(start+24,length), magic=optional.length>=2?optional.readUInt16LE(0):0, wide=magic===0x20b, prefix=wide?112:96;
  if (![0x10b,0x20b].includes(magic) || length<prefix || (declared==='i386')===wide) fail('invalid PE optional header');
  const sections=r.get(start+24+length,count*40), headers=optional.readUInt32LE(60);
  function rva(address, bytes) {
    if (address < headers && bytes <= headers-address) return r.get(address,bytes);
    for(let i=0;i<count;i++) { const o=i*40, va=sections.readUInt32LE(o+12), rawSize=sections.readUInt32LE(o+16), raw=sections.readUInt32LE(o+20);
      if(address>=va && address-va<rawSize && bytes<=rawSize-(address-va)) return r.get(raw+address-va,bytes);
    }
    fail('PE RVA outside section bounds');
  }
  let machine=declared, hybrid=null;
  const directories=optional.readUInt32LE(prefix-4);
  if (directories>(length-prefix)/8) fail('PE directories outside optional header bounds');
  if (wide && directories>10) {
    const address=optional.readUInt32LE(prefix+80), bytes=optional.readUInt32LE(prefix+84);
    if(address && bytes) {
      if(bytes<4) fail('PE load config outside directory bounds');
      const config=rva(address,bytes), size=config.readUInt32LE(0);
      if(size>bytes) fail('PE load config outside directory bounds');
      if(size>=208) {
        const pointer=config.readBigUInt64LE(200), imageBase=optional.readBigUInt64LE(24);
        if(pointer) {
          if(pointer<imageBase) fail('CHPE pointer below image base');
          const meta=rva(safe(pointer-imageBase),12), version=meta.readUInt32LE(0), codeMap=meta.readUInt32LE(4), entries=meta.readUInt32LE(8);
          const map=rva(codeMap,entries*8), types=new Set();
          for(let i=0;i<entries;i++) { const start=map.readUInt32LE(i*8), type=start&3, size=map.readUInt32LE(i*8+4); if(type===3) fail('unknown CHPE code type'); if(size) { const codeStart=start-(start&3), imageSize=optional.readUInt32LE(56); if(codeStart>imageSize || size>imageSize-codeStart) fail('CHPE code range outside image bounds'); types.add(['arm64','arm64ec','x86_64'][type]); } }
          hybrid={ version, codeArchitectures:[...types] };
          if(declared==='arm64' && types.has('arm64ec')) machine='arm64x';
          else if(declared==='x86_64' && types.has('arm64ec')) machine='arm64ec';
        }
      }
    }
  }
  return {format:'pe',machine,machineCode,...(hybrid?{hybrid}:{})};
}
function elf(r) {
  const ident=r.get(0,16), bits=ident[4]===1?32:ident[4]===2?64:0, endian=ident[5]===1?'LE':ident[5]===2?'BE':null;
  if(!bits || !endian || ident[6]!==1) fail('invalid ELF identification');
  const b=r.get(0,bits===64?64:52), u16=o=>b[`readUInt16${endian}`](o), u32=o=>b[`readUInt32${endian}`](o), u64=o=>safe(b[`readBigUInt64${endian}`](o));
  const machine=ELF.get(u16(18));if(!machine) fail('unsupported ELF machine');
  if(u16(bits===64?52:40)!==b.length) fail('invalid ELF header size');
  const wide = bits === 64, phoff = wide ? u64(32) : u32(28), shoff = wide ? u64(40) : u32(32);
  const phsize = u16(wide ? 54 : 42), shsize = u16(wide ? 58 : 46);
  let phnum = u16(wide ? 56 : 44), shnum = u16(wide ? 60 : 48);
  if (phnum === 0xffff || (!shnum && shoff)) {
    if (shsize < (wide ? 64 : 40)) fail('ELF extended counts require a section header');
    const zero = r.get(shoff, wide ? 64 : 40);
    if (!shnum) shnum = wide ? safe(zero[`readBigUInt64${endian}`](32)) : zero[`readUInt32${endian}`](20);
    if (phnum === 0xffff) phnum = zero[`readUInt32${endian}`](wide ? 44 : 28);
  }
  for (const [offset, entrySize, count, minimum] of [[phoff, phsize, phnum, wide ? 56 : 32], [shoff, shsize, shnum, wide ? 64 : 40]]) {
    if (count && (entrySize < minimum || offset > r.size || count > (r.size - offset) / entrySize)) fail('ELF table outside file bounds');
  }
  return {format:'elf',machine,bits,endian:endian.toLowerCase()};
}
function inspect(r) {
 const b=r.get(0,4);
 if(b.readUInt16LE(0)===0x5a4d) return pe(r);
 if(b.readUInt32BE(0)===0x7f454c46) return elf(r);
 return macho(r);
}
function parseBinary(buffer) { if(!Buffer.isBuffer(buffer)) throw new TypeError('A binary Buffer is required.'); return inspect(reader(buffer.length,(o,n)=>buffer.subarray(o,o+n))); }
function inspectBinary(file) {
 const fd=fs.openSync(file,'r');
 try { return inspect(reader(fs.fstatSync(fd).size,(offset,length)=>{const b=Buffer.alloc(length);if(fs.readSync(fd,b,0,length,offset)!==length) fail('file changed during inspection');return b;})); }
 finally {fs.closeSync(fd);}
}
module.exports={parseBinary,inspectBinary};
