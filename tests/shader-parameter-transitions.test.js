const assert = require("node:assert/strict"), path = require("node:path"), test = require("node:test"), Module = require("node:module");
const React = require("react"), {build} = require("vite"), {renderToStaticMarkup} = require("react-dom/server");
const {react, componentHarness} = require("./helpers/renderer-component");
let ShaderParameters;
test.before(async () => {
  const result = await build({configFile: false, logLevel: "silent", build: {ssr: path.join(__dirname, "../src/renderer/src/ui/components/ShaderParameters.tsx"), write: false,
    rollupOptions: {external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: {format: "cjs", codeSplitting: false}}}});
  const compiled = new Module(path.join(__dirname, "shader-parameter-transitions.cjs"), module);compiled.paths = module.paths;
  compiled.require = id => id === "react" ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(result.output.find(row => row.type === "chunk").code, compiled.id);({ShaderParameters} = compiled.exports);
});
function elements(value) {return React.isValidElement(value) ? [value, ...React.Children.toArray(value.props.children).flatMap(elements)] : [];}
async function controls(onChange) {
  const parameters = ["First", "Second"].map(name => ({name, label: name, type: "float", default: [0]}));
  const harness = componentHarness(ShaderParameters, {gamePath: "/Game", settings: {parameters: {Existing: [3]}}, live: false, onChange,
    loadParameters: async () => ({parameters})});
  elements(harness.render()).find(node => node.type === "button").props.onClick();await harness.settle();
  return {harness, input: name => elements(harness.render()).find(node => node.props.id === `shader-${name}-0`)};
}
test("rapid parameter edits combine before props refresh and failed edits do not leak into later saves", async () => {
  const writes = [], finishes = [];
  const {harness, input} = await controls(async (_, patch) => {
    writes.push(structuredClone(patch));return new Promise((resolve, reject) => finishes.push({resolve, reject}));
  });
  try {
    input("First").props.onValue(1);input("Second").props.onValue(2);
    finishes[0].resolve();await harness.settle();
    assert.deepEqual(writes[1].parameters, {Existing: [3], First: [1], Second: [2]});
    finishes[1].reject(new Error("Second could not be saved."));await harness.settle();
    assert.equal(input("First").props.value, 1);assert.equal(input("Second").props.value, 0);
    assert.match(renderToStaticMarkup(harness.render()), /Second could not be saved\./);
    input("First").props.onValue(4);await harness.settle();
    assert.deepEqual(writes[2].parameters, {Existing: [3], First: [4]});
    finishes[2].resolve();await harness.settle();
  } finally {harness.close();}
});
test("queued parameters rebase after a rejected earlier edit and Reset stays ordered", async () => {
  const writes = [], finishes = [];
  const {harness, input} = await controls(async (_, patch) => {
    writes.push(structuredClone(patch));return new Promise((resolve, reject) => finishes.push({resolve, reject}));
  });
  try {
    input("First").props.onValue(1);input("Second").props.onValue(2);
    finishes[0].reject(new Error("First rejected"));await harness.settle();
    assert.deepEqual(writes[1].parameters, {Existing: [3], Second: [2]});
    elements(harness.render()).find(node => node.type === "button" && node.props.children === "Reset parameters").props.onClick();
    input("First").props.onValue(4);finishes[1].resolve();await harness.settle();
    assert.deepEqual(writes[2], {parameters: null});finishes[2].resolve();await harness.settle();
    assert.deepEqual(writes[3], {parameters: {First: [4]}});finishes[3].resolve();await harness.settle();
  } finally {harness.close();}
});
test("parameter saves preserve newer external values while rebasing queued components", async () => {
  const writes=[], finishes=[], parameters=[{name:'Vector',label:'Vector',type:'float',default:[0,0]},{name:'Second',label:'Second',type:'float',default:[0]}];
  const props={gamePath:'/Game',settings:{parameters:{Vector:[0,0]}},live:true,disclosure:false,loadParameters:async()=>({parameters}),
    onChange:async(_,patch)=>{writes.push(patch);await new Promise(resolve=>finishes.push(resolve));}};
  const harness=componentHarness(ShaderParameters,props),input=id=>elements(harness.render()).find(node=>node.props.id===id);
  try{
    harness.render();await harness.settle();input('shader-Vector-0').props.onValue(1);
    props.settings={parameters:{Vector:[0,9],External:[7]}};harness.render();input('shader-Second-0').props.onValue(2);
    finishes.shift()();await harness.settle();assert.deepEqual(writes[1].parameters,{Vector:[1,9],External:[7],Second:[2]});
    props.settings={parameters:{Vector:[1,9],External:[8],Second:[4]}};harness.render();finishes.shift()();await harness.settle();
    assert.equal(input('shader-Second-0').props.value,4,'a newer same-component value survives the older save completion');
    input('shader-Vector-1').props.onValue(5);assert.deepEqual(writes[2].parameters,{Vector:[1,5],External:[8],Second:[4]});finishes.shift()();await harness.settle();
  }finally{harness.close();}
});
test("unmount discards queued parameter writes after the in-flight save settles", async () => {
  const writes = [];let finish;
  const {harness, input} = await controls(async (_, patch) => {writes.push(patch);await new Promise(resolve => {finish = resolve;});});
  input("First").props.onValue(1);input("Second").props.onValue(2);
  harness.close();finish();await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, [{parameters: {Existing: [3], First: [1]}}]);
});
test("queued parameter edits keep their original selection callback across a parent refresh", async () => {
  const calls = [], parameters = ["First", "Second"].map(name => ({name, label: name, type: "float", default: [0]}));let finish;
  const props = {gamePath: "/Game", settings: {parameters: {}}, live: true, loadParameters: async () => ({parameters}),
    onChange: async (_, patch) => {calls.push(["original selection", patch]);if (calls.length === 1) await new Promise(resolve => {finish = resolve;});}};
  const harness = componentHarness(ShaderParameters, props), input = name => elements(harness.render()).find(node => node.props.id === `shader-${name}-0`);
  try {
    elements(harness.render()).find(node => node.type === "button").props.onClick();await harness.settle();
    input("First").props.onValue(1);input("Second").props.onValue(2);
    props.onChange = async (_, patch) => {calls.push(["replacement selection", patch]);};harness.render();finish();await harness.settle();
    assert.deepEqual(calls.map(call => call[0]), ["original selection", "original selection"]);
    input("First").props.onValue(4);await harness.settle();assert.equal(calls[2][0], "replacement selection", "new edits use the current callback");
  } finally {harness.close();}
});
test("late parameter metadata after unmount cannot populate the retired editor", async () => {
  let finish;
  const harness = componentHarness(ShaderParameters, {gamePath: "/Game", live: false, onChange: () => assert.fail("metadata must not save"),
    loadParameters: () => new Promise(resolve => {finish = resolve;})});
  elements(harness.render()).find(node => node.type === "button").props.onClick();harness.close();
  finish({parameters: [{name: "Late", label: "Late", type: "float", default: [1]}]});await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements(harness.render()).some(node => node.props.id === "shader-Late-0"), false);
});
test('an already-open effect Options panel shows parameters directly without a second disclosure',async()=>{
 let reads=0;const harness=componentHarness(ShaderParameters,{gamePath:'/Game',live:true,disclosure:false,onChange:()=>assert.fail('Opening options cannot save'),loadParameters:async()=>{reads++;return{parameters:[{name:'Exposure',label:'Exposure',type:'float',default:[0]}]}}});
 try{harness.render();await harness.settle();const markup=renderToStaticMarkup(harness.render());assert.equal(reads,1);assert.match(markup,/shader-Exposure-0/);assert.doesNotMatch(markup,/Shader parameters…|Hide parameters/);}finally{harness.close();}
});
