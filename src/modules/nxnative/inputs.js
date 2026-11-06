const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const MAX_TABLE = 16 * 1024 * 1024, MAX_RECORDS = 100000;
const inside = (root, file) => { const p = path.relative(root, file); return p === '' || p !== '..' && !p.startsWith('..' + path.sep) && !path.isAbsolute(p); };
function read(file, offset, size) {
  const out = Buffer.alloc(size), fd = fs.openSync(file, 'r');
  try { if (fs.readSync(fd, out, 0, size, offset) !== size) throw Error('Truncated Switch metadata.'); } finally { fs.closeSync(fd); }
  return out;
}
function nup(file) {
  const size = fs.statSync(file).size, h = read(file, 0, 128);
  if (!h.subarray(0, 4).equals(Buffer.from([78,85,80,1]))) return null;
  const number = (b, at) => { const v = b.readBigUInt64LE(at); if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Switch metadata exceeds its size limit.'); return Number(v); };
  const offset = number(h, 8), length = number(h, 16), blob = number(h, 56), count = h.readUInt32LE(72);
  if (h.readUInt16LE(4) < 128 || offset !== h.readUInt16LE(4) || number(h, 64) !== size || h.readUInt32LE(76) || length < 48 || length > MAX_TABLE || length > size - offset || blob < offset + length || blob > size || blob % 16 || !count || count > 4096) throw Error('Invalid NUP header.');
  const t = read(file, offset, length);
  if (!crypto.createHash('sha256').update(t).digest().equals(h.subarray(24,56)) || !t.subarray(0,4).equals(Buffer.from([84,79,67,1])) || t.readUInt32LE(4) !== count) throw Error('Invalid NUP table.');
  const dirs = number(t,8), files = number(t,16), pool = number(t,24), poolSize = number(t,32), start = 48 + count * 64, fileStart = start + dirs * 24, slots = fileStart + files * 80;
  if (dirs + files > MAX_RECORDS || pool < slots || (pool - slots) % 4 || poolSize > length - pool) throw Error('Invalid NUP records.');
  const name = (at, root = false) => {
    const off = t.readUInt32LE(at), len = t.readUInt32LE(at + 4);
    if (off > poolSize || len > poolSize - off || len > 4096) throw Error('Invalid NUP name.');
    const v = t.toString('utf8', pool + off, pool + off + len);
    if ((!v && !root) || /[\0/\\]/.test(v) || ['.', '..'].includes(v)) throw Error('Unsafe NUP name.');
    return v;
  };
  const packages = [], seen = new Set();
  for (let i = 0; i < count; i++) {
    const at = 48 + i * 64, title = t.readBigUInt64LE(at), kind = t[at+24], flags = t[at+25], version = t.readUInt32LE(at+20);
    const meta = number(t, at+32), metaSize = t.readUInt32LE(at+40);
    if (kind > 4 || flags & ~1 || t.readUInt16LE(at+26) || t.readUInt32LE(at+28) || meta > size || metaSize > size-meta) throw Error('Invalid NUP package.');
    for (const o of [8,12,16]) { const index = t.readUInt32LE(at+o); if (index >= dirs && !(o !== 8 && index === 0xffffffff)) throw Error('Invalid NUP directory.'); }
    const key = `${kind}:${title}:${version}`; if (seen.has(key)) throw Error('Duplicate NUP package.'); seen.add(key);
    packages.push({ title, kind, version, standalone: Boolean(flags & 1), code: t.readUInt32LE(at+12) !== 0xffffffff, romfs: t.readUInt32LE(at+16) !== 0xffffffff });
  }
  const children = [];
  for (let i=0; i<dirs; i++) {
    const at = start+i*24; name(at,true); const first=t.readUInt32LE(at+8), n=t.readUInt32LE(at+12);
    if (first+n > (pool-slots)/4) throw Error('Invalid NUP children.');
    const row=[], names=new Set();
    for(let j=first;j<first+n;j++) { const child=t.readUInt32LE(slots+j*4); if(child>=dirs+files) throw Error('Invalid NUP child.'); const label=name(child<dirs?start+child*24:fileStart+(child-dirs)*80); if(names.has(label)) throw Error('Duplicate NUP child.'); names.add(label); if(child<dirs)row.push(child); }
    children.push(row);
  }
  const visiting=new Set(), done=new Set();
  function visit(i,depth) { if(depth>64||visiting.has(i))throw Error('NUP directory cycle or depth limit.'); if(done.has(i))return; visiting.add(i); for(const c of children[i])visit(c,depth+1); visiting.delete(i);done.add(i); }
  for(let i=0;i<dirs;i++)visit(i,0);
  for(let i=0;i<files;i++) {
    const at=fileStart+i*80;name(at);const bytes=number(t,at+8),off=number(t,at+16),stored=number(t,at+24),codec=t[at+64];
    if(codec>1||t[at+65]||bytes && (off<blob||off%16||!stored||stored>size-off||codec===0&&bytes!==stored)||!bytes&&(off||stored||codec))throw Error('Invalid NUP extent.');
  }
  const bases=packages.filter(p=>p.kind===0), updates=packages.filter(p=>p.kind===1);
  if(bases.length>1)throw Error('Multiple NUP base games.');
  const base=bases[0], id=base?.title || (updates[0]?.title ? updates[0].title & ~0xfffn : 0n);
  if(id & 0xfffn || id && packages.some(p=>p.kind===1&&(p.title & ~0xfffn)!==id||p.kind===2&&(p.title<=id+0x1000n||p.title>id+0x1000n+2000n)))throw Error('Unrelated NUP packages.');
  const fullBase=base?.code;
  if(!fullBase&&(!updates.length||updates.some(p=>!p.standalone||!p.code||!p.romfs)))throw Error('NUP needs a base game or standalone update.');
  const versions=[...(fullBase&&base.romfs?[0]:[]),...updates.map(p=>p.version)].sort((a,b)=>a-b);
  if(!versions.length)throw Error('NUP has no playable package.');
  return facts('nup','Switch NUP',file,id,versions);
}
function facts(format, sourceKind, inputPath, title, versions) {
  return {format,sourceKind,inputPath,titleId:title ? title.toString(16).padStart(16,'0').toUpperCase() : null,versions:versions.map(v=>'v'+v),selectedUpdate:'v'+versions.at(-1),generation:null,keyRequirement:'none',keysRequired:false,inspectionOnly:false,canDecompile:false};
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
