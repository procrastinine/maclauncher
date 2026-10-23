import {createRequire} from 'node:module';
const source=createRequire(import.meta.url)('../runtime-source');
const implementation=await import(source.moduleUrl('art/boot-classpath.mjs'));
export const {guestHooksArchive,runtimeBootClasspath}=implementation;
