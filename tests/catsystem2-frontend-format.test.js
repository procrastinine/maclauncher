const test=require('node:test'),assert=require('node:assert/strict');
const {formatFrontEndString:format}=require('../src/modules/catsystem2/runtime/frontend-format');
const machine={value:source=>Number(source)};
test('FES integer formats apply exact argument order, padding, signs and literal percent without recursive expansion',()=>{
  assert.equal(format('se_%02d_%4d_%%_%d',['5','-2','2147483647'],machine),'se_05_  -2_%_2147483647');
  assert.equal(format('%05d',['-7'],machine),'-0007');assert.equal(format('%%02d',[],machine),'%02d');
  assert.equal(format('plain',[],machine),'plain');assert.equal(format('%d',['-2147483648'],machine),'-2147483648');
});
test('FES formatting rejects pointer fields, missing arguments, unsafe width, overflow and NUL output',()=>{
  for(const [source,args] of [['%s',['0']],['%n',['0']],['%d',[]],['%257d',['1']],['%d',['2147483648']],['a\0b',[]],['%d',['NaN']]])
    assert.throws(()=>format(source,args,machine),/unsupported|limit|range/);
  assert.throws(()=>format('x'.repeat(4097),[],machine),/limit/);
});
