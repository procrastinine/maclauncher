const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
function compiledKind(bytes) {
  const hex = bytes.subarray(0,8).toString('hex'), ascii = bytes.subarray(0,8).toString('latin1');
  // Source artwork remains source even when its file extension is unfamiliar.
  if (/^(89504e470d0a1a0a|ffd8ff|47494638|69636e73|00000100|4f676753|664c6143|774f4646|774f4632|4f54544f|00010000)/.test(hex) ||
      (ascii.startsWith('RIFF') && ['WEBP','WAVE'].includes(bytes.subarray(8,12).toString()))) return null;
  if (/^(cffaedfe|cefaedfe|feedfacf|feedface|cafebabe|bebafeca|cafebabf|bfbafeca)/.test(hex)) return 'Mach-O/Java class';
  if (ascii.startsWith('\x7fELF')) return 'ELF';
  if (ascii.startsWith('MZ')) return 'PE';
  if (bytes.length >= 20 && [0x14c,0x8664,0xaa64].includes(bytes.readUInt16LE()) && bytes.readUInt16LE(2)>0 && bytes.readUInt16LE(2)<97 && bytes.readUInt16LE(16)===0) return 'COFF object';
  if (hex.startsWith('0061736d')) return 'WebAssembly';
  if (/^504b(0304|0506|0708)/.test(hex)) return 'ZIP/JAR/APK/wheel';
  if (ascii.startsWith('dex\n') || ascii.startsWith('cdex')) return 'DEX';
  if (ascii.startsWith('!<arch>\n')) return 'static archive';
  if (hex.startsWith('03000800')) return 'binary XML';
  if (bytes[0]===0x80 && bytes[1]>=1 && bytes[1]<=5 || /^(?:\(dp\d+\n|ccopy_reg\n|c__builtin__\n)/.test(ascii)) return 'pickle';
  if (ascii.startsWith('RPA-')) return 'RPA';
  if (bytes.subarray(257,262).toString()==='ustar' || /^(1f8b|fd377a585a00|377abcaf271c|425a68|28b52ffd)/.test(hex)) return 'packed archive';
  return null;
}
test('tracked source contains no compiled code or archives', () => {
  const root=path.resolve(__dirname,'..');
  const rows=execFileSync('git',['ls-files','--stage','-z'],{cwd:root,maxBuffer:32*1024*1024}).toString().split('\0').filter(Boolean);
  const found=[];
  for(const row of rows){
    const match=/^(\d+) [a-f0-9]+ \d\t(.+)$/.exec(row);if(!match||!['100644','100755'].includes(match[1]))continue;
    const name=match[2],file=path.join(root,name);let fd;
    try{fd=fs.openSync(file,'r');const bytes=Buffer.alloc(512),size=fs.readSync(fd,bytes,0,bytes.length,0),kind=compiledKind(bytes.subarray(0,size));if(kind)found.push(name+' ('+kind+')');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  assert.deepEqual(found,[],'Compiled payloads belong in releases; source retains public pins or text generators:\n'+found.join('\n'));
});
test('binary source guard recognizes formats and keeps source artwork',()=>{
  for(const bytes of [Buffer.from('cffaedfe','hex'),Buffer.from('\x7fELF'),Buffer.from('MZ'),Buffer.from('PK\x03\x04'),Buffer.from('dex\n035\0'),Buffer.from('!<arch>\n'),Buffer.from('03000800','hex'),Buffer.from([128,4]),Buffer.from('RPA-3.0'),Buffer.from('1f8b','hex'),Buffer.from('fd377a585a00','hex'),Buffer.from('377abcaf271c','hex')])assert.ok(compiledKind(bytes));
  for(const bytes of [Buffer.from('source text'),Buffer.from('89504e470d0a1a0a','hex'),Buffer.from('00010000','hex'),Buffer.from('OggS')])assert.equal(compiledKind(bytes),null);
});
