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
 return packageRuntime(options,metadata);
}
