'use strict';
function verifyPublisher(source,{pin,archiveSha256}) {
 for(const rule of source.verify) {
  if(rule.type!=='github-asset-digest')throw new Error('The selected source verification needs its canonical transport.');
  const declared=pin.asset?.sha256;
  if(!/^[a-f0-9]{64}$/i.test(declared||''))throw new Error('The publisher supplied no SHA-256 for this archive.');
  if(declared.toLowerCase()!==archiveSha256?.toLowerCase())throw new Error('The archive does not match its publisher SHA-256.');
 }
 return source.verify.length?{verified:true,identity:'publisher-sha256:'+archiveSha256}:null;
}
module.exports={verifyPublisher};
