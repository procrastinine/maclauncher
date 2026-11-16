'use strict';
// System translation needs no file placement. Guest translation consumes only
// the client/helper closure and destinations admitted by the shared plan.
function apply({build,parts,environment={},parameters}={}){
 if(!(build?.binaries||[]).length)return{environment:{...environment}};
 if(!parts?.files?.length)throw new Error('The selected CPU translator has no admitted client/helper projection.');
 return require('./selected-files').apply({build,parts,environment,parameters});
}
module.exports={apply};
