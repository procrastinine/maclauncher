const fs = require('node:fs');
const path = require('node:path');
const MAX_TABLE = 16 * 1024 * 1024;
const inside = (root, file) => { const p = path.relative(root, file); return p === '' || p !== '..' && !p.startsWith('..' + path.sep) && !path.isAbsolute(p); };
function read(file, offset, size) {
  const out = Buffer.alloc(size), fd = fs.openSync(file, 'r');
  try { if (fs.readSync(fd, out, 0, size, offset) !== size) throw Error('Truncated Switch metadata.'); } finally { fs.closeSync(fd); }
  return out;
}
function nup(file) {
  const size = fs.statSync(file).size;
  if (size < 4 || !read(file, 0, 4).equals(Buffer.from([78, 85, 80, 1]))) return null;
  const result = facts('nup', 'Switch NUP', file, 0n, []);
  try {
    const h = read(file, 0, 128), offset = h.readBigUInt64LE(8), count = h.readUInt32LE(72);
    const length = 48 + count * 64;
    if (offset > BigInt(Number.MAX_SAFE_INTEGER) || !count || length > MAX_TABLE || offset + BigInt(length) > BigInt(size)) return result;
    const table = read(file, Number(offset), length), versions = new Set(); let title = 0n;
    for (let index = 0; index < count; index++) {
      const at = 48 + index * 64, id = table.readBigUInt64LE(at), kind = table[at + 24];
      if (kind === 0) { title ||= id; versions.add(0); }
      if (kind === 1) { title ||= id & ~0xfffn; versions.add(table.readUInt32LE(at + 20)); }
    }
    return facts('nup', 'Switch NUP', file, title, [...versions].sort((a, b) => a - b));
  } catch { return result; } // Recognition survives absent or newer metadata; the runtime validates the input.
}
function facts(format, sourceKind, inputPath, title, versions) {
  return {format,sourceKind,inputPath,titleId:title ? title.toString(16).padStart(16,'0').toUpperCase() : null,versions:versions.map(v=>'v'+v),selectedUpdate:versions.length ? 'v'+versions.at(-1) : null,generation:null,keyRequirement:'none',keysRequired:false,inspectionOnly:false,canDecompile:false};
}
function dump(folder) {
  const root=fs.realpathSync(folder);
  function safe(file) { if(!inside(root,fs.realpathSync(file)))throw Error('Switch dump path escapes the imported folder.');return file; }
  function is(file,method) { try {safe(file);return fs.statSync(file)[method]();}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')return false;throw e;} }
  function program(file) {
    safe(file);const size=fs.statSync(file).size;if(size<128||size>1024*1024)throw Error('Invalid NPDM size.');const h=read(file,0,128),at=h.readUInt32LE(112),n=h.readUInt32LE(116);
    if(h.toString('ascii',0,4)!=='META'||n<24||at<128||n>size-at)throw Error('Invalid NPDM.');const a=read(file,at,24);if(a.toString('ascii',0,4)!=='ACI0')throw Error('Invalid NPDM ACI0.');return a.readBigUInt64LE(16);
  }
  const code=p=>is(path.join(p,'exefs/main.npdm'),'isFile'),rom=p=>is(path.join(p,'romfs'),'isDirectory');
  const base=code(path.join(folder,'base'))?path.join(folder,'base'):code(folder)?folder:null;
  const updates=path.join(folder,'updates'),rows=[];
  if(is(updates,'isDirectory')) {
    const names=fs.readdirSync(updates);if(names.length>4096)throw Error('Too many Switch updates.');
    for(const name of names)if(/^\d+$/.test(name)&&is(path.join(updates,name),'isDirectory')) {const v=Number(name);if(!Number.isSafeInteger(v)||v>0xffffffff||rows.some(r=>r.v===v))throw Error('Invalid or duplicate update version.');rows.push({v,p:path.join(updates,name)});}
  }
  rows.sort((a,b)=>a.v-b.v);
  if(!base&&!rows.some(r=>code(r.p)&&rom(r.p)))return null;
  if(base&&!rom(base)&&!rows.some(r=>rom(r.p)))throw Error('Switch dump is missing RomFS.');
  const chosen=base||rows.filter(r=>code(r.p)&&rom(r.p)).at(-1).p,id=program(path.join(chosen,'exefs/main.npdm'));
  if(!id||id & 0xfffn)throw Error('Invalid base program ID.');
  for(const r of rows)if(!code(r.p)||!rom(r.p)||program(path.join(r.p,'exefs/main.npdm'))!==id)throw Error('Update needs matching ExeFS and full RomFS.');
  const dlc=path.join(folder,'dlc');if(is(dlc,'isDirectory')) {
    const names=fs.readdirSync(dlc);if(names.length>2000)throw Error('Too many DLC packages.');
    for(const name of names) {const p=path.join(dlc,name);if(!is(p,'isDirectory')||name.startsWith('.'))continue;if(!/^[a-f\d]{1,16}$/i.test(name))throw Error('Invalid DLC title ID.');const t=BigInt('0x'+name);if(t<=id+0x1000n||t>id+0x1000n+2000n)throw Error('Unrelated DLC.');const dirs=fs.readdirSync(safe(p));if(dirs.length>4096)throw Error('Too many DLC folders.');const roms=dirs.filter(n=>is(path.join(p,n,'romfs'),'isDirectory'));if(roms.length!==1&&!(!roms.length&&rom(p)))throw Error('DLC needs one RomFS.');}
  }
  return facts('dump','Switch decrypted dump',folder,id,[...(base&&rom(base)?[0]:[]),...rows.map(r=>r.v)]);
}
module.exports={nup,dump,MAX_TABLE};
