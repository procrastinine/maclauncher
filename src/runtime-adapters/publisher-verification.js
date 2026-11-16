'use strict';
function verifyPublisher(_source,{pin,archiveSha256}){const declared=pin.asset?.sha256;if(!declared)return null;if(declared.toLowerCase()!==archiveSha256?.toLowerCase())throw new Error('The archive does not match its publisher SHA-256.');return {verified:true,identity:'publisher-sha256:'+archiveSha256};}
module.exports={verifyPublisher};
