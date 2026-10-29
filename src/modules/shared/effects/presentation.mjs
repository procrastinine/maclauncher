import {NEURAL,MODEL_OPERATIONS} from './operation-contracts.mjs';
import {shaderGeometry,followsRowSize,GRAPHICS_TYPES} from './contracts.mjs';

// Presentation groups do not admit an implementation to an input/output slot.
// In a resize slot, shaders whose output follows the row's size are listed
// after the fixed-direction choices.
export const IMPLEMENTATION_GROUPS=Object.freeze(['Simple algorithms','Native algorithms','Neural','Shaders','Any size']);
const resizing=type=>type==='downsample'||type==='upscale';
export function implementationGroup(row,type){
  const node=row.template||row,method=node.method;
  if(node.kind==='shader'&&resizing(type)&&followsRowSize(row))return 'Any size';
  if(NEURAL[method]||row.traits?.neural||['temporal','frame-generation'].includes(node.kind)&&['metalfx','metalfx-denoised'].includes(method))return 'Neural';
  if(node.kind==='shader')return 'Shaders';
  return row.category==='Standard filters'||['bilinear','bicubic','nearest','downsample'].includes(method)?'Simple algorithms':'Native algorithms';
}
// Menus head a shader from an installed collection with its group and the
// collection's name; it follows the group's other shaders.
const collectionOf=row=>(row.template||row).kind==='shader'&&typeof row.collection==='string'?row.collection:'';
// Catalog recommendation ranks set the menu tiers: recommended and common
// rows (rank 0 or 1) lead under one heading, ordinary groups follow, then rows
// whose scene inputs the game's frame source does not supply last. Specialised
// variants (rank 3) stay behind More; once shown, they follow the other rows
// under their group's heading, so no heading repeats.
const tierOf=row=>{const rank=row.recommendationRank??2;return row.inputsAbsent?2:rank<=1?0:rank>=3?3:1;};
const sectionOf=row=>{const tier=tierOf(row);return tier===3?1:tier;};
export const implementationMore=row=>tierOf(row)===3;
// Ordinary shaders are headed by the purpose their catalog row carries, in
// this order; shaders without one follow under Shaders.
export const SHADER_PURPOSES=Object.freeze(['Sharpen','Colour and tone','CRT and retro','Anti-aliasing and blur','Lighting and lens','Restoration','Depth','Accessibility','Artistic']);
const purposeOf=(row,type)=>implementationGroup(row,type)==='Shaders'&&!collectionOf(row)&&SHADER_PURPOSES.includes(row.purpose)?row.purpose:'';
const purposeRank=(row,type)=>{const purpose=purposeOf(row,type);return purpose?SHADER_PURPOSES.indexOf(purpose):SHADER_PURPOSES.length;};
export function implementationHeading(row,type){
  const tier=tierOf(row);
  if(tier===0)return 'Recommended';
  if(tier===2)return 'Needs scene inputs';
  const group=implementationGroup(row,type),collection=collectionOf(row);
  return collection?`${group} · ${collection}`:purposeOf(row,type)||group;
}
// A pack effect is labeled "Family · Name". A menu shows the name alone when
// the family is already evident from the name, the section's type or the
// row's heading. Stored identifiers and library names keep the full label.
export function implementationName(row,type){
  const family=row.family,label=String(row.label??'');
  if(typeof family!=='string'||!family||!label.startsWith(family+' · '))return label;
  const name=label.slice(family.length+3),word=family.toLocaleLowerCase();
  return [name,GRAPHICS_TYPES.find(item=>item.id===type)?.label,implementationHeading(row,type)].some(text=>typeof text==='string'&&text.toLocaleLowerCase().includes(word))?name:label;
}
export function orderImplementationGroups(rows,type){
  const kernelRank=row=>implementationGroup(row)==='Simple algorithms'?({bilinear:0,bicubic:1,nearest:2}[String(row.template?.method||row.method).replace(/^libplacebo:/,'')]??3):0;
  return [...rows].sort((a,b)=>sectionOf(a)-sectionOf(b)||(tierOf(a)===0?(a.recommendationRank??2)-(b.recommendationRank??2):0)||
    IMPLEMENTATION_GROUPS.indexOf(implementationGroup(a,type))-IMPLEMENTATION_GROUPS.indexOf(implementationGroup(b,type))||
    purposeRank(a,type)-purposeRank(b,type)||collectionOf(a).localeCompare(collectionOf(b))||tierOf(a)-tierOf(b)||kernelRank(a)-kernelRank(b));
}
// libplacebo labels a filter without a description, such as an alias, with its
// identifier, and some descriptions join words.
export function libplaceboFilterLabel(name,label){
  const text=typeof label==='string'&&label&&label!==name?label:name==='nearest'?'Nearest neighbor':
    String(name).replace(/_/g,' ').replace(/\b[a-z]/g,letter=>letter.toUpperCase()).replace(/^Ewa\b/,'EWA');
  return text.replace(/([a-z])([A-Z])/g,'$1 $2');
}
const factor=value=>`${Math.round(value*1000)/1000}×`;
export function implementationOutputSummary(row,type){
  const output=row.outputContract,geometry=shaderGeometry(row);
  if(geometry.refines==='upscale'||row.traits?.recommendedPlacement==='during-upscale')return 'Upscale refinement';
  if(geometry.refines==='downsample')return 'Downsample refinement';
  if(!row.nodeId&&row.intrinsicScales?.length>1)return row.intrinsicScales.map(scale=>`${scale}×`).join(' / ');
  if(output?.domain==='timeline')return 'Intermediate frames';
  if(output?.sizing==='scene-output')return 'Size set in options';
  if(geometry.kind==='identity')return 'Same size';
  if(geometry.kind==='scale')return geometry.scale.x===geometry.scale.y?factor(geometry.scale.x):`${factor(geometry.scale.x)} / ${factor(geometry.scale.y)}`;
  if(geometry.kind==='size')return geometry.size.width&&geometry.size.height?`${geometry.size.width} × ${geometry.size.height}`:geometry.size.width?`${geometry.size.width}px wide`:`${geometry.size.height}p`;
  const range=geometry.range;
  if(range){
    if(range.min.x!==range.min.y||range.max.x!==range.max.y)return 'Conditional size';
    return range.min.x===1&&range.max.x>1?`Up to ${factor(range.max.x)}`:`${factor(range.min.x)}–${factor(range.max.x)}`;
  }
  if(geometry.kind==='target')return type==='image'&&followsRowSize(row)?'Same size':'Size set in options';
  return 'Unknown size';
}
export function implementationHelp(row){
  const placement=row.traits?.recommendedPlacement||row.recommendedPlacement,geometry=shaderGeometry(row);
  if(placement==='after-upscale')return 'Recommended after upscaling.';
  if(placement==='during-upscale')return 'Refines resizing inside the same shader provider, retaining its low-resolution reference; a separate prior upscale does not supply that reference.';
  if(geometry.kind==='conditional')return 'The shader conditionally changes image size within its declared range. Its provider then fits the requested target.';
  if(geometry.kind==='size')return 'The shader declares a fixed output resolution independent of its input.';
  if(followsRowSize(row))return 'Resamples to the row\'s output size. As an image filter it keeps the input size.';
  if(implementationOutputSummary(row)==='Unknown size')return 'The output size is not known from the shader declarations. No upscale or downsample direction is inferred.';
  return '';
}

export function modelPresentation(method,scale) {
  const operation=MODEL_OPERATIONS[method||'mlx-dlss'];
  if(operation?.kind==='attachment')return {inputOutputLabel:'Image → relative depth',purpose:'Estimates relative depth from an image for compatible image filters; it does not supply renderer depth.'};
  if(operation?.kind==='frame-generation')return {inputOutputLabel:'Two frames → intermediate frames',purpose:'Estimates intermediate images between two real frames.'};
  if(operation?.kind==='temporal')return {inputOutputLabel:`Scene → upscaled image${scale?` · ${scale}×`:''}`,purpose:'Reconstructs an image using real scene depth, motion and camera inputs.'};
  if(operation?.kind==='upscale')return {inputOutputLabel:`Image → upscaled image${scale?` · ${scale}×`:''}`,purpose:'Upscales an image with a trained model at its intrinsic output scale.'};
  return {inputOutputLabel:'Image → same-size image',purpose:operation?.history==='optional-image'?'Reconstructs detail at the processing size, with optional history from real images.':'Restores an image at its input dimensions with a trained denoising or deblurring model.'};
}

