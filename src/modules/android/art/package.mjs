import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const Source=require('../runtime-source');
const Bundled=require('../../shared/runtime/bundled-native');
const MachO=require('../../shared/runtime/macho-load-commands');
const Supplementals=require('../../../../scripts/native-supplementals.cjs');
const {packageArtAdapter:packageRuntime}=await import(Source.moduleUrl('art/package.mjs'));
const metadata={fileInventory:Bundled.fileInventory,readMachOLoadCommands:MachO.readMachOLoadCommands,
 versionAtLeast:Bundled.versionAtLeast,validatePublicMetadata:Supplementals.validatePublicMetadata,
 validateDeclaration:Supplementals.validateDeclaration,verifyPayload:Bundled.verifyPayload};

/** Preserve the launcher producer entry while runtime assembly has one owner. */
export function packageArtAdapter(options){
 let {commonDeclaration}=options;
 if(!commonDeclaration){
  const manifestFile=path.join(options.commonRoot,'runtime.json');
  const bytes=fs.readFileSync(manifestFile),manifest=JSON.parse(bytes);
  if(!manifest.notices?.length){
   const identity=crypto.createHash('sha256').update(bytes).digest('hex');
   const declarations=require('../managed-packages.json');
   commonDeclaration=declarations.find(row=>row.id==='android'&&row.manifestRelative==='runtime.json'&&row.manifestSha256===identity);
   if(!commonDeclaration)throw Error('Android ART packaging requires the matching common runtime declaration.');
  }
 }
 return packageRuntime({...options,commonDeclaration},metadata);
}
