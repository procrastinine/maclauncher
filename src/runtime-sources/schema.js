'use strict';
const {getKind} = require('../core/component-kinds');
const FORMATS = Object.freeze({macho:['i386','x86_64','arm','arm64'],pe:['i386','x86_64','arm64','arm64ec','arm64x'],elf:['x86','x86_64','arm','aarch64']});
const DISCOVERY_TYPES=Object.freeze(['github-releases','builds-catalog','local-app','system']);
const idPattern=/^[a-z0-9][a-z0-9-]*$/;
function invalid(message) { throw new TypeError(`Runtime source: ${message}`); }
function object(value,field) { if(!value || typeof value!=='object' || Array.isArray(value)) invalid(`${field} must be an object`); }
function string(value,field) { if(typeof value!=='string'||!value.trim()) invalid(`${field} must be a nonempty string`); }
function strings(value,field) { if(!Array.isArray(value)||value.some(v=>typeof v!=='string'||!v)) invalid(`${field} must be an array of strings`); }
function relative(value,field) { string(value,field); if(value.startsWith('/') || value.includes('\\') || value.split('/').some(v=>v==='..') || value.includes('\0')) invalid(`${field} must be relative to the installation`); }
function regex(value,field) {string(value,field);try{new RegExp(value);}catch{invalid(`${field} is not a regular expression`);} }
function interfaces(value,field) {if(value===undefined)return;object(value,field);for(const k of ['provides','requires'])if(value[k]!==undefined)strings(value[k],`${field}.${k}`);}
function declares(value) {object(value,'declares');if(!Object.keys(value).length)invalid('declares must name binary architectures');for(const [format,arches] of Object.entries(value)){if(!FORMATS[format])invalid(`unknown binary format ${format}`);strings(arches,`declares.${format}`);if(!arches.length||arches.some(a=>!FORMATS[format].includes(a)))invalid(`invalid ${format} architecture declaration`);}}
function validateReach(tuple) {object(tuple,'reach');for(const k of ['guestFormat','guestArch','hostArch','integration'])string(tuple[k],`reach.${k}`);if(!FORMATS[tuple.guestFormat]?.includes(tuple.guestArch))invalid('reach guest format/architecture is invalid');if(!FORMATS.macho.includes(tuple.hostArch))invalid('reach hostArch is invalid');if(tuple.requires!==undefined)strings(tuple.requires,'reach.requires');return tuple;}
function validateSource(value) {
 object(value,'source');for(const k of ['id','kind','label','license'])string(value[k],k);
 if(!idPattern.test(value.id)||!getKind(value.kind))invalid('invalid source id or kind');
 object(value.discover,'discover');if(!DISCOVERY_TYPES.includes(value.discover.type))invalid('unknown discovery type');
 if(value.discover.type==='github-releases'){string(value.discover.repo,'discover.repo');if(!/^[\w.-]+\/[\w.-]+$/.test(value.discover.repo))invalid('invalid GitHub repository');if(value.discover.tag)regex(value.discover.tag,'discover.tag');}
 if(value.discover.type==='builds-catalog')string(value.discover.catalog,'discover.catalog');
 for(const key of ['version','tag','digest','sha256','asset'])if(value.discover[key]!==undefined && !(key==='tag'&&value.discover.type==='github-releases'))invalid(`discovery cannot pin ${key}`);
 if(value.assets!==undefined){if(!Array.isArray(value.assets))invalid('assets must be an array');for(const asset of value.assets){object(asset,'asset');regex(asset.match,'asset.match');declares(asset.declares);}}
 if(['github-releases','builds-catalog'].includes(value.discover.type)&&!value.assets?.length)invalid('downloadable sources require asset declarations');
 object(value.layout,'layout');string(value.layout.type,'layout.type');if(value.layout.entry)relative(value.layout.entry,'layout.entry');
 if(value.embeds!==undefined){if(!Array.isArray(value.embeds))invalid('embeds must be an array');for(const embed of value.embeds){if(!getKind(embed.kind))invalid('unknown embedded kind');string(embed.id,'embed.id');relative(embed.path,'embed.path');interfaces(embed.interfaces,'embed.interfaces');if(embed.reach)embed.reach.forEach(validateReach);}}
 interfaces(value.interfaces,'interfaces');if(value.reach){if(!Array.isArray(value.reach))invalid('reach must be an array');value.reach.forEach(validateReach);}
 object(value.credits,'credits');string(value.credits.url,'credits.url');if(!/^https:\/\//.test(value.credits.url))invalid('credits URL must use HTTPS');
 object(value.verify,'verify');string(value.verify.type,'verify.type');if(value.verify.match)regex(value.verify.match,'verify.match');
 return value;
}
function validateDeclared(declared,binaries) {
 declares(declared);const measured={};
 for(const binary of binaries){if(!FORMATS[binary.format])invalid('unknown measured binary format');const arches=binary.format==='macho'?binary.architectures:[binary.machine];for(const arch of arches||[])(measured[binary.format] ||= new Set()).add(arch);}
 for(const [format,arches] of Object.entries(declared))for(const arch of arches)if(!measured[format]?.has(arch))throw new Error(`Runtime architecture mismatch: declared ${JSON.stringify(declared)}; measured ${JSON.stringify(Object.fromEntries(Object.entries(measured).map(([f,a])=>[f,[...a]])))}`);
 return true;
}
module.exports={FORMATS,DISCOVERY_TYPES,validateSource,validateReach,validateDeclared};
