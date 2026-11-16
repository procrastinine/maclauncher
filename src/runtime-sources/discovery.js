'use strict';
const Upstream=require('../modules/shared/runtime/upstream');
const {validateSource}=require('./schema');

// Called by an explicit Refresh or consented preparation. Merely loading source
// declarations or resolving an installed build never invokes this transport.
async function discoverSource(source,{signal,logger,github=Upstream.github}={}) {
 validateSource(source);
 const unsupported=reason=>({source:source.id,kind:source.kind,available:false,reason,candidates:[]});
 if(source.discover.type!=='github-releases')return unsupported(`Discovery transport ${source.discover.type} is not configured.`);
 if(Object.keys(source.discover).some(key=>!['type','repo','tag','includePrereleases'].includes(key)))return unsupported('The source has unsupported discovery constraints.');
 const tag=source.discover.tag&&new RegExp(source.discover.tag);
 const rules=source.assets.map(rule=>({pattern:new RegExp(rule.match),declares:rule.declares}));
 const verificationRules=source.verify.filter(rule=>rule.type==='sums-file').map(rule=>new RegExp(rule.match));
 const verification={test:name=>verificationRules.some(rule=>rule.test(name))};
 const publisher=github({repository:source.discover.repo,allArchitectures:true,prerelease:source.discover.includePrereleases===true,recognize:release=>{
  if(release.prerelease&&!source.discover.includePrereleases)return [];
  if(tag&&!tag.test(release.tag_name||''))return [];
  const assets=(release.assets||[]).filter(asset=>rules.some(rule=>rule.pattern.test(asset.name||''))||verification?.test(asset.name||''));
  return assets.some(asset=>rules.some(rule=>rule.pattern.test(asset.name||'')))?[{version:release.tag_name,assets}]:[];
 }});
 const rows=await publisher.discover({signal,logger});
 const ordered=rows.map((row,index)=>({row,index})).sort((a,b)=>{
  const left=Date.parse(a.row.publishedAt),right=Date.parse(b.row.publishedAt);
  return Number.isFinite(left)&&Number.isFinite(right)&&left!==right?right-left:a.index-b.index;
 });
 const release=ordered[0]?.row;
 if(!release)return unsupported('No matching published release is listed.');
 const candidates=[];
 for(const file of release.files||[]) {
  const matches=rules.filter(rule=>rule.pattern.test(file.name||''));
  if(!matches.length)continue;
  if(source.verify.some(rule=>rule.type==='github-asset-digest')&&file.digest?.algorithm!=='sha256')return unsupported(`Asset ${file.name} has no published GitHub SHA-256.`);
  if(matches.length!==1)return unsupported(`Asset ${file.name} matches more than one architecture declaration.`);
  candidates.push({id:`${source.kind}:${source.id}:${release.revision}:${file.id||file.name}`,source:source.id,kind:source.kind,
   version:matches[0].pattern.exec(file.name||'')?.groups?.version||release.version,installed:false,measured:false,prerelease:release.prerelease===true,asset:Upstream.asset(file),declares:structuredClone(matches[0].declares),
   verificationFiles:(release.files||[]).filter(candidate=>verification?.test(candidate.name||'')).map(Upstream.asset),
   provenance:{revision:release.revision,sourceUrl:release.sourceUrl,publishedAt:release.publishedAt}});
 }
 return {source:source.id,kind:source.kind,available:candidates.length>0,candidates};
}
module.exports={discoverSource};
