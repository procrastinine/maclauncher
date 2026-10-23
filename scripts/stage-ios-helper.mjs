// Build the small included storage adapter; PlayCover remains a managed download.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const Native = require('../src/modules/shared/runtime/local-native');
const source = path.join(root, 'src/modules/ios/native');
const sources = ['playtools-paths.swift', 'playtools-interpose.c', 'device-identity.m', 'build.mjs'];
const digest = crypto.createHash('sha256');
for (const file of sources) digest.update(file).update(fs.readFileSync(path.join(source,file)));
const version = '1.0.0-' + digest.digest('hex').slice(0,8), id = 'ios-playtools-paths';
const directoryRelative = `${id}/${version}/arm64`;
const directory = path.join(root,'src/resources/native-runtimes',directoryRelative);
fs.mkdirSync(directory,{recursive:true});
execFileSync(process.execPath,[path.join(source,'build.mjs'),directory],{stdio:'inherit'});
for (const file of sources) fs.copyFileSync(path.join(source,file),path.join(directory,file));
fs.copyFileSync(path.join(root,'LICENSE'),path.join(directory,'license.txt'));
const library = path.join(directory,'libplaytools-paths.dylib');
const minimumMacOS = require('./stage-native-runtimes.cjs').loadCommands(library).minimumMacOS;
if (minimumMacOS !== '12.0') throw new Error('Unexpected PlayTools adapter deployment target.');
const manifest = {schemaVersion:1,id,version,minimumMacOS,architectures:['arm64'],
  sourceSha256:Native.hashFile(path.join(source,'playtools-paths.swift')),binarySha256:Native.hashFile(library),
  sources:Object.fromEntries(sources.map(file=>[file,Native.hashFile(path.join(source,file))])),
  scope:'private-playtools-file-url-and-vendor-identifier',build:{signing:'ad-hoc',installName:'@rpath/libplaytools-paths.dylib'}};
fs.writeFileSync(path.join(directory,'helper.json'),JSON.stringify(manifest,null,2)+'\n');
const files = fs.readdirSync(directory).sort().map(name=>{
  const file=path.join(directory,name);fs.chmodSync(file,name.endsWith('.dylib')?0o755:0o644);
  return {path:name,size:fs.statSync(file).size,mode:fs.statSync(file).mode&0o777,sha256:Native.hashFile(file),...(name.endsWith('.dylib')?{architectures:['arm64']}:{} )};
});
const declaration = {id,version,arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS,
  sourceRelative:'playtools-paths.swift',sourceSha256:manifest.sourceSha256,directoryRelative,manifestRelative:'helper.json',manifestSha256:Native.hashFile(path.join(directory,'helper.json')),files,
  notices:[{name:'MacLauncher PlayTools storage adapter',license:'MIT',path:'license.txt'}]};
require('./native-supplementals.cjs').validateDeclaration(declaration);
fs.writeFileSync(path.join(root,'src/modules/ios/distribution-supplementals.json'),JSON.stringify([declaration],null,2)+'\n');
console.log(directoryRelative);
