// Copyright (c) MacLauncher contributors. MIT license.
// Bounded arithmetic shared as a data AST with the Metal resource allocator.
const functions={abs:Math.abs,ceil:Math.ceil,floor:Math.floor,round:Math.round,sqrt:Math.sqrt,min:Math.min,max:Math.max,pow:Math.pow,exp:Math.exp,log:Math.log,log2:Math.log2};
function parse(source,names){
  if(typeof source!=="string"||source.length>2048)throw Error("The Magpie texture size expression is invalid.");
  const tokens=source.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_]\w*|\S/g)||[];let at=0,count=0;
  function expression(min=0){if(++count>256)throw Error("The Magpie texture size expression is too complex.");let token=tokens[at++],left;
    if(token==="+"||token==="-")left=[token==="-"?"neg":"pos",expression(4)];
    else if(token==="("){left=expression();if(tokens[at++]!==")")throw Error("The Magpie size expression has unmatched parentheses.");}
    else if(/^(?:\d|\.)/.test(token||"")){left=Number(token);if(!Number.isFinite(left))throw Error("The Magpie texture size is not finite.");}
    else if(Object.hasOwn(functions,token)&&tokens[at]==="("){at++;const args=[];do{args.push(expression());if(tokens[at]!==",")break;at++;}while(args.length<16);if(tokens[at++]!==")")throw Error("The Magpie size function is invalid.");left=[token,...args];}
    else if(names.has(token))left=["var",token];else throw Error("The Magpie size expression uses an unknown identifier: "+String(token));
    const precedence={"+":1,"-":1,"*":2,"/":2,"%":2,"^":3};
    while((precedence[tokens[at]]||0)>min){const op=tokens[at++],power=precedence[op];left=[op,left,expression(op==="^"?power-1:power)];}return left;
  }
  const ast=expression();if(at!==tokens.length)throw Error("The Magpie texture size expression is invalid.");return ast;
}
function evaluate(ast,values){if(typeof ast==="number")return ast;if(ast[0]==="var")return values[ast[1]];const args=ast.slice(1).map(value=>evaluate(value,values));switch(ast[0]){case"pos":return args[0];case"neg":return-args[0];case"+":return args[0]+args[1];case"-":return args[0]-args[1];case"*":return args[0]*args[1];case"/":return args[0]/args[1];case"%":return args[0]%args[1];case"^":return args[0]**args[1];default:return functions[ast[0]](...args);}}
// Only prove a same-axis homogeneous extent. Sampling square sizes can mistake
// a cross-axis or nonlinear expression for a fixed scale.
function relative(ast,variable){
  function affine(node){
    if(typeof node==="number")return [0,node];
    if(node[0]==="var")return node[1]===variable?[1,0]:null;
    const a=affine(node[1]),b=node.length>2?affine(node[2]):null;
    if(!a)return null;
    switch(node[0]){
      case "pos":return a;case "neg":return a.map(value=>-value);
      case "+":return b?[a[0]+b[0],a[1]+b[1]]:null;
      case "-":return b?[a[0]-b[0],a[1]-b[1]]:null;
      case "*":return !b?null:a[0]===0?b.map(value=>value*a[1]):b[0]===0?a.map(value=>value*b[1]):null;
      case "/":return b&&b[0]===0&&b[1]!==0?a.map(value=>value/b[1]):null;
      default:return null;
    }
  }
  const value=affine(ast);return value&&value[1]===0&&Number.isFinite(value[0])&&value[0]>0?value[0]:null;
}
module.exports={parse,evaluate,relative};
