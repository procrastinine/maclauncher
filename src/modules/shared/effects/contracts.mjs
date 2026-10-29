// Graphics transforms are defined by their data contract. Implementations,
// including imported shaders, share the same graph and execution paths.
export const GRAPHICS_TYPES = Object.freeze([
  Object.freeze({id:"image",label:"Image filter",input:"image",output:"image"}),
  Object.freeze({id:"downsample",label:"Downsample",input:"image",output:"smaller-image"}),
  Object.freeze({id:"upscale",label:"Upscale",input:"image",output:"larger-image"}),
  Object.freeze({id:"temporal",label:"Temporal upscaling",input:"scene",output:"reconstructed-image"}),
  Object.freeze({id:"generation",label:"Frame generation",input:"image-sequence",output:"denser-image-sequence"})
]);
export const graphicsGroup = type => type==="downsample"||type==="upscale"?"Resize":type==="temporal"||type==="generation"?"Temporal":"Image filters";
const DIRECTIONS = Object.freeze(["downsample","upscale"]);
const pair = value => typeof value==="number"?Number.isFinite(value)?{x:value,y:value}:null:value&&Number.isFinite(value.x)&&Number.isFinite(value.y)?{x:value.x,y:value.y}:null;
const scalingType = value => {
  value=pair(value);if(!value)return null;
  if(value.x>=1&&value.y>=1&&(value.x>1||value.y>1))return "upscale";
  if(value.x<=1&&value.y<=1&&(value.x<1||value.y<1))return "downsample";
  return null;
};
const listed = values => DIRECTIONS.filter(value=>Array.isArray(values)&&values.includes(value));
export const extentEditable = row => row?.outputContract?.extentEditable??(!row?.intrinsicScale&&!row?.traits?.outputScale&&row?.traits?.outputExtentEditable!==false);
// A priori output geometry from declared contracts only; names, collections
// and semantic tags never contribute. Kinds: identity, scale (fixed factor of
// the input), size (fixed pixels), conditional (a declared condition selects
// between sizes), target (follows the row's output size; without one, the
// presentation or the input as noted in `target`) and unknown.
export function shaderGeometry(implementation = {}) {
  const contract=implementation.outputContract||{},traits=implementation.traits||{};
  const context=contract.resizeContext??traits.resizeContext;
  if(DIRECTIONS.includes(context))return {kind:"target",directions:[context],refines:context,target:context==="upscale"?"presentation":"input"};
  const scale=pair(contract.scale??implementation.intrinsicScale??traits.outputScale);
  if(scale){const direction=scalingType(scale);return direction||scale.x!==1||scale.y!==1?{kind:"scale",scale,directions:direction?[direction]:[]}:{kind:"identity",directions:[]};}
  const size=traits.outputSize;
  if(size&&[size.width,size.height].some(Number.isInteger))return {kind:"size",size:{...(Number.isInteger(size.width)?{width:size.width}:{}),...(Number.isInteger(size.height)?{height:size.height}:{})},directions:[]};
  const directions=listed(contract.resizeDirections??traits.resizeDirections??[contract.direction]),range=contract.scaleRange??traits.outputScaleRange;
  // The runtime gives display-dependent and conditional rules the presentation
  // as their target; other target-sized providers default to the input size.
  const target=traits.conditionalGeometry||traits.displayDependentGeometry||traits.unresolvedGeometry?"presentation":"input";
  if(range?.min&&range?.max)return {kind:"conditional",range,target,directions:directions.length?directions:
    [...(range.min.x<1||range.min.y<1?["downsample"]:[]),...(range.max.x>1||range.max.y>1?["upscale"]:[])]};
  const composite=contract.compositeTarget||traits.compositeTarget;
  if(!composite&&(contract.preservesSize||traits.preservesSize||contract.sizing==="preserve"))return {kind:"identity",directions:[]};
  if(composite||contract.sizing==="stage"||traits.requestedOutputExtent)return {kind:"target",directions,target};
  if(traits.conditionalGeometry&&directions.length)return {kind:"conditional",directions,target};
  return {kind:"unknown",directions,target};
}
// A complete declared pixel size is the row's output size, so it is placed
// and executed like a fixed-resolution row.
const fixedSize = geometry => geometry.kind==="size"&&geometry.size.width&&geometry.size.height?geometry.size:null;
// Output request for a shader row without a saved extent. It derives from the
// same geometry that places the row, so Simple's type and execution agree.
export function shaderDefaultOutput(implementation = {}) {
  const geometry=shaderGeometry(implementation),size=fixedSize(geometry);
  return geometry.target==="presentation"?{outputExtent:"presentation"}:geometry.kind==="scale"?{outputScale:geometry.scale}:size?{outputSize:size}:{};
}
// A shader whose output may differ from its input needs the ordered executor,
// a plane-group boundary and a render resolution offer. Conditional scalers and
// analyzed but unresolved geometry count; a shader without analysis does not.
export function shaderResizes(implementation = {}) {
  const geometry=shaderGeometry(implementation);
  return ["scale","size","conditional"].includes(geometry.kind)||geometry.target==="presentation"||
    geometry.kind==="unknown"&&Boolean(implementation.traits?.unresolvedGeometry);
}
// Direction implied by a requested shader output size: a fixed pixel size is
// a processing size, and a full presentation fit enlarges or fits the image.
function extentType(extent) {
  if(!extent)return null;
  if(extent.automatic)return "downsample";
  if(extent.relativeTo==="input")return scalingType(extent.factor);
  if(extent.relativeTo==="presentation")return Number.isFinite(extent.factor)?extent.factor<1?"downsample":"upscale":null;
  return "downsample";
}
function shaderType(node, implementation) {
  const geometry=shaderGeometry(implementation),only=geometry.directions.length===1?geometry.directions[0]:null;
  if((geometry.kind==="target"||geometry.kind==="unknown")&&extentEditable(implementation)){
    const sized=extentType(node.extent??(geometry.kind==="target"&&geometry.target==="presentation"?{relativeTo:"presentation",factor:1}:undefined));
    if(sized&&(!geometry.directions.length||geometry.directions.includes(sized)))return sized;
  }
  const size=fixedSize(geometry);
  return size?extentType(size):geometry.kind==="identity"||geometry.kind==="size"?"image":only||"image";
}

export function graphicsType(node, implementation = {}) {
  if(node?.kind==="frame-generation"||implementation.outputContract?.domain==="timeline")return "generation";
  if(node?.kind==="temporal"||implementation.outputContract?.sizing==="scene-output")return "temporal";
  if(node?.kind==="shader")return shaderType(node,implementation);
  if(node?.kind==="downsample"||node?.kind==="upscale")return node.kind;
  if(node?.extent?.automatic)return "downsample";
  if(node?.extent?.relativeTo==="input"){
    const selected=scalingType(node.extent.factor);if(selected)return selected;
  }
  if(node?.extent?.relativeTo==="presentation"&&Number.isFinite(node.extent.factor))return node.extent.factor<1?"downsample":"upscale";
  const direction=implementation.outputContract?.direction;
  if(direction==="downsample"||direction==="upscale")return direction;
  const declared=scalingType(implementation.outputContract?.scale??implementation.intrinsicScale??implementation.traits?.outputScale);
  if(declared)return declared;
  // Only the old spatial node uses a method to distinguish its reduction
  // operation. Names of shaders and semantic search tags are never consulted.
  if(node?.kind==="spatial")return node.method==="downsample"||node.settings?.spatialMultiplier<1?"downsample":"upscale";
  return "image";
}
// Default size of a shader placed in a slot. Resize slots have fixed
// defaults. In the image slot a shader that would otherwise follow the window
// keeps its input size.
export function slotExtent(type, implementation) {
  if(type==="downsample")return {relativeTo:"input",factor:.5};
  if(type==="upscale")return {relativeTo:"presentation",factor:1};
  if(type!=="image"||implementation?.template?.kind!=="shader"||!extentEditable(implementation))return undefined;
  return graphicsType({...implementation.template,extent:undefined},implementation)==="image"?undefined:{relativeTo:"input",factor:1};
}
// A refinement shader starts at the size of the resize it refines; other
// shaders start without a size and follow their geometry.
export function defaultShaderExtent(implementation = {}) {
  const refines=shaderGeometry(implementation).refines;
  return refines?slotExtent(refines):undefined;
}
// A target-sized shader without a single declared direction takes its row's
// size: the input size as an image filter, the chosen size when resizing.
export function followsRowSize(implementation = {}) {
  const geometry=shaderGeometry(implementation);
  return geometry.kind==="target"&&geometry.directions.length!==1;
}

export function sameImplementation(node, implementation) {
  const candidate=implementation?.template;if(!node||!candidate)return false;
  if(node.kind==="shader"||candidate.kind==="shader")return node.kind==="shader"&&candidate.kind==="shader"&&node.shader?.preset===candidate.shader?.preset;
  return node.method===candidate.method&&(node.kind===candidate.kind||node.kind==="spatial"&&candidate.kind==="upscale");
}

// Ordinary menus list a shader under the type of its default size and, for
// an authored resampler, under each declared direction. A resampler declaring
// both directions is also an image filter at its input size. Explicit placement
// may also use a requested output size when the slot's default size yields
// that type. Only declared geometry decides membership, so an imported copy and
// a collection shader with the same source are listed identically.
export function implementationsFor(type, catalog, {contextual=false} = {}) {
  return catalog.filter(row=>{
    if(row.template?.kind!=="shader")return graphicsType(row.template,row)===type;
    const geometry=shaderGeometry(row);
    if(graphicsType(row.template,row)===type||geometry.kind==="target"&&geometry.directions.includes(type))return true;
    const twoWay=geometry.kind==="target"&&geometry.directions.length===2&&type==="image";
    if(!twoWay&&(!contextual||!["target","unknown"].includes(geometry.kind))||!extentEditable(row))return false;
    const extent=slotExtent(type,row);
    return Boolean(extent)&&graphicsType({...row.template,extent},row)===type;
  });
}

// Search and library group: listed under a resize slot, or the declared type.
export const catalogGroup = row => DIRECTIONS.some(type=>implementationsFor(type,[row]).length)?"Resize":graphicsGroup(graphicsType(row.template,row));

// Recommendation ranks: 0 is the suggested default, 1 a common choice, an
// unranked row is ordinary (2) and 3 a specialised variant.
export function orderImplementations(catalog) {
  return [...catalog].sort((a,b)=>(a.recommendationRank??2)-(b.recommendationRank??2));
}

// Fit targets follow the current presentation in either direction. Explicit
// image factors and pixel extents retain their selected resize direction.
export function isPresentationFit(node) {
  if(node.extent)return node.extent.relativeTo==="presentation"&&Number.isFinite(node.extent.factor);
  if(node.outputSize)return false;
  if(node.presentationScale!==undefined)return Number.isFinite(node.presentationScale);
  return node.settings?.spatialMultiplier==null;
}
export function bidirectionalFitImplementation(catalog, preferredMethod) {
  const down=new Set(catalog.filter(row=>row.available===true&&row.template?.kind==="downsample").map(row=>row.template.method));
  const rows=catalog.filter(row=>row.available===true&&row.template?.kind==="upscale"&&down.has(row.template.method));
  return rows.find(row=>row.template.method===preferredMethod)||orderImplementations(rows).find(row=>row.recommendationRank===0)||
    ["bicubic","bilinear"].map(method=>rows.find(row=>row.template.method===method)).find(Boolean)||rows[0];
}
