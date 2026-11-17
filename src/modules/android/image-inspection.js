const fs = require('node:fs'), path = require('node:path');
const Binary = require('../../core/binary-arch');
const {fileDigest} = require('../shared/runtime/verified-identity');
const REQUIRED = ['system/build.prop', 'system/bin/linker64', 'system/bin/app_process64'];
const architecture = machine => ({aarch64:'arm64',x86_64:'x64',arm:'arm',x86:'x86'})[machine];
function guestFile(root,relative){
  let pending=relative.split('/'),resolved=[],links=0;
  while(pending.length){
    const part=pending.shift();if(!part||part==='.')continue;
    if(part==='..'){resolved.pop();continue;}
    const file=path.join(root,...resolved,part),stat=fs.lstatSync(file);
    if(stat.isSymbolicLink()){
      if(++links>40)throw Error('The Android image contains a cyclic guest link.');
      const target=fs.readlinkSync(file);
      if(/[\0\\]/.test(target))throw Error('The Android image contains an invalid guest link.');
      if(target.startsWith('/'))resolved=[];
      pending=[...target.split('/'),...pending];
    }else{resolved.push(part);if(pending.length&&!stat.isDirectory())throw Error('An Android image parent is not a directory.');}
  }
  return path.join(root,...resolved);
}
function inspectRoot(input) {
  let root = path.resolve(input);
  if (!fs.lstatSync(root).isDirectory()) {
    const suffix = ['system/bin/linker64','system/bin/linker','apex/com.android.runtime/bin/linker64','apex/com.android.runtime/bin/linker']
      .map(name=>name.split('/').join(path.sep)).find(suffix=>root.endsWith(path.sep+suffix));
    if (!suffix) throw Error('Select the Android image root or its system linker file.');
    root = root.slice(0, -suffix.length - 1);
  }
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw Error('The Android image root must be a directory.');
  const present=relative=>{try{fs.lstatSync(path.join(root,relative));return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
  const wide = present('system/bin/linker64');
  const required = wide ? REQUIRED : ['system/build.prop','system/bin/linker',
    present('system/bin/app_process32')?'system/bin/app_process32':'system/bin/app_process'];
  const files = required.map(relative => {
    const file = guestFile(root, relative), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw Error('The Android system image is missing a required regular file: ' + relative);
    if(relative.startsWith('system/bin/')&&!(stat.mode&0o111))throw Error('The Android guest file is not executable: '+relative);
    const real = fs.realpathSync(file);
    if (!real.startsWith(fs.realpathSync(root) + path.sep)) throw Error('The Android image file escapes its root.');
    return {path:relative,resolved:path.relative(root,file).split(path.sep).join('/'),sha256:fileDigest(file).sha256,size:stat.size,mode:stat.mode&0o7777};
  });
  const cpus = required.slice(1).map(relative => {
    const file=guestFile(root,relative),facts = Binary.inspectBinary(file),header=Buffer.alloc(18),fd=fs.openSync(file,'r');
    try{fs.readSync(fd,header,0,header.length,0);}finally{fs.closeSync(fd);}
    if (facts.format !== 'elf' || facts.bits !== (wide?64:32)) throw Error('The Android image requires matching guest ELF files.');
    if(![2,3].includes(header[facts.endian==='le'?'readUInt16LE':'readUInt16BE'](16)))throw Error('The Android image requires executable guest ELF files.');
    return architecture(facts.machine);
  });
  if (!cpus[0] || cpus.some(cpu => cpu !== cpus[0])) throw Error('The Android system image contains inconsistent guest CPU files.');
  const executablePath = guestFile(root,required[1]);
  return {root,installDir:root,executablePath,architectures:[cpus[0]],architecture:cpus[0],guestArchitecture:cpus[0],files};
}
module.exports = {inspectRoot,REQUIRED};
