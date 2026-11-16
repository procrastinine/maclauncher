'use strict';
const Upstream=require('../modules/shared/runtime/upstream');
const {validateSource}=require('./schema');

// Called by an explicit Refresh or consented preparation. Merely loading source
// declarations or resolving an installed build never invokes this transport.
async function discoverSource(source,{signal,logger,github=Upstream.github}={}) {
 validateSource(source);
 const unsupported=reason=>({source:source.id,kind:source.kind,available:false,reason,candidates:[]});
 if(source.discover.type!=='github-releases')return unsupported(`Discovery transport ${source.discover.type} is not configured.`);
 if(Object.keys(source.discover).some(key=>!['type','repo','tag'].includes(key)))return unsupported('The source has unsupported discovery constraints.');
 const tag=source.discover.tag&&new RegExp(source.discover.tag);
 const rules=source.assets.map(rule=>({pattern:new RegExp(rule.match),declares:rule.declares}));
 const verification=source.verify.match&&new RegExp(source.verify.match);
 const publisher=github({repository:source.discover.repo,allArchitectures:true,recognize:release=>{
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
  if(matches.length!==1)return unsupported(`Asset ${file.name} matches more than one architecture declaration.`);
  candidates.push({id:`${source.kind}:${source.id}:${release.revision}:${file.id||file.name}`,source:source.id,kind:source.kind,
   version:release.version,installed:false,asset:Upstream.asset(file),declares:structuredClone(matches[0].declares),
   verificationFiles:(release.files||[]).filter(candidate=>verification?.test(candidate.name||'')).map(Upstream.asset),
   provenance:{revision:release.revision,sourceUrl:release.sourceUrl,publishedAt:release.publishedAt}});
 }
 return {source:source.id,kind:source.kind,available:candidates.length>0,candidates};
}
module.exports={discoverSource};
