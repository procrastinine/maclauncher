const LIMITS = Object.freeze({ characters: 4096, tokens: 2048, nodes: 1024, depth: 64 });
const PRECEDENCE = Object.freeze({ "=": 1, "+=": 1, "-=": 1, "*=": 1, "/=": 1, "%=": 1, "&=": 1, "|=": 1, "^=": 1, "<<=": 1, ">>=": 1,
  "||": 2, "&&": 3, "|": 4, "^": 5, "&": 6, "==": 7, "!=": 7, "<": 8, ">": 8, "<=": 8, ">=": 8, "<<": 9, ">>": 9,
  "+": 10, "-": 10, "*": 11, "/": 11, "%": 11 });
const ASSIGNMENTS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]);
function lex(source) {
  if (typeof source !== "string" || !source.length || source.length > LIMITS.characters) throw new Error("FES expression exceeds its character limit.");
  const tokens = []; let at = 0;
  while (at < source.length) {
    if (/\s/.test(source[at])) { at++; continue; }
    const found = /^(?:0x[0-9a-fA-F]+|\d+|[A-Za-z_][A-Za-z0-9_]*|<<=|>>=|\+\+|--|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|==|!=|<=|>=|&&|\|\||<<|>>|[()\[\]$\\@+\-*/%&|^~!=<>])/.exec(source.slice(at));
    if (!found || tokens.length >= LIMITS.tokens) throw new Error("FES expression token is unsupported or oversized.");
    tokens.push(found[0]); at += found[0].length;
  }
  return tokens;
}
function parseExpression(source) {
  const words = lex(source); let at = 0, nodes = 0;
  const node = value => { if (++nodes > LIMITS.nodes) throw new Error("FES expression exceeds its node limit."); return value; };
  function parse(minimum = 1, depth = 0) {
    if (depth > LIMITS.depth) throw new Error("FES expression nesting exceeds its limit.");
    const token = words[at++]; let left;
    if (["!", "~", "+", "-", "++", "--"].includes(token)) left = node({ kind: "unary", operator: token, value: parse(12, depth + 1) });
    else if (token === "(") { left = parse(1, depth + 1); if (words[at++] !== ")") throw new Error("FES expression parentheses are incomplete."); }
    else if (token === "$" || token === "\\") {
      let index;
      if (words[at] === "(") { at++; index = parse(1, depth + 1); if (words[at++] !== ")") throw new Error("FES variable index parentheses are incomplete."); }
      else {
        const value = words[at++]; if (!/^(?:\d+|0x[0-9a-f]+)$/i.test(value || "")) throw new Error("FES variable index is unsupported.");
        index = node({ kind: "number", value: Number(value) });
      }
      left = node({ kind: "variable", region: token === "$" ? "globals" : "locals", index });
    } else if (/^(?:\d+|0x[0-9a-f]+)$/i.test(token || "")) {
      const value = Number(token); if (!Number.isSafeInteger(value) || value > 0xffffffff) throw new Error("FES integer literal exceeds its range."); left = node({ kind: "number", value: value | 0 });
    } else if (token === "@") left = node({ kind: "current" });
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token || "")) {
      left = node({ kind: "name", name: token });
      if (words[at] === "[") { at++; left.index = parse(1, depth + 1); if (words[at++] !== "]") throw new Error("FES object index is incomplete."); }
    } else throw new Error("FES expression operand is unsupported.");
    while (["++", "--"].includes(words[at])) left = node({ kind: "postfix", operator: words[at++], value: left });
    while (PRECEDENCE[words[at]] >= minimum) {
      const operator = words[at++], precedence = PRECEDENCE[operator], right = parse(precedence + (ASSIGNMENTS.has(operator) ? 0 : 1), depth + 1);
      left = node({ kind: "binary", operator, left, right });
    }
    return left;
  }
  const result = parse(); if (at !== words.length) throw new Error("FES expression contains unsupported trailing syntax."); return result;
}
function evaluateExpression(node, context = {}, depth = 0) {
  if (depth > LIMITS.depth) throw new Error("FES expression evaluation exceeds its nesting limit.");
  const evaluate = value => evaluateExpression(value, context, depth + 1);
  const integer = value => { if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error("FES expression value is not a finite integer."); return value | 0; };
  function reference(target) {
    if (target.kind !== "variable") throw new Error("FES assignment requires a writable variable.");
    const values = context[target.region], index = evaluate(target.index);
    if (!(values instanceof Int32Array) || index < 0 || index >= values.length) throw new Error("FES variable index exceeds its declared region.");
    return { get: () => values[index], set: value => values[index] = integer(value) };
  }
  function binary(operator, left, right) {
    switch (operator) {
      case "+": return (left + right) | 0; case "-": return (left - right) | 0; case "*": return Math.imul(left, right);
      case "/": if (!right) throw new Error("FES division by zero."); return Math.trunc(left / right) | 0;
      case "%": if (!right) throw new Error("FES remainder by zero."); return (left % right) | 0;
      case "&": return left & right; case "|": return left | right; case "^": return left ^ right; case "<<": return left << (right & 31); case ">>": return left >> (right & 31);
      case "==": return Number(left === right); case "!=": return Number(left !== right); case "<": return Number(left < right); case ">": return Number(left > right);
      case "<=": return Number(left <= right); case ">=": return Number(left >= right);
      default: throw new Error("FES expression operator is unsupported.");
    }
  }
  if (node?.kind === "number") return node.value;
  if (node?.kind === "variable") return reference(node).get();
  if (node?.kind === "current") return integer(typeof context.current === "function" ? context.current() : context.current ?? 0);
  if (node?.kind === "name") return integer(context.resolveName?.(node.name, node.index ? evaluate(node.index) : null));
  if (node?.kind === "unary" || node?.kind === "postfix") {
    if (node.operator === "++" || node.operator === "--") {
      const ref = reference(node.value), old = ref.get(), value = ref.set(old + (node.operator === "++" ? 1 : -1)); return node.kind === "postfix" ? old : value;
    }
    const value = evaluate(node.value);
    if (node.operator === "!") return Number(value === 0); if (node.operator === "~") return ~value; if (node.operator === "-") return -value | 0; if (node.operator === "+") return value;
  }
  if (node?.kind === "binary") {
    if (ASSIGNMENTS.has(node.operator)) { const ref = reference(node.left); return ref.set(node.operator === "=" ? evaluate(node.right) : binary(node.operator.slice(0, -1), ref.get(), evaluate(node.right))); }
    const left = evaluate(node.left);
    if (node.operator === "&&") return left ? Number(evaluate(node.right) !== 0) : 0;
    if (node.operator === "||") return left ? 1 : Number(evaluate(node.right) !== 0);
    return binary(node.operator, left, evaluate(node.right));
  }
  throw new Error("FES expression node is unsupported.");
}
const expression = (source, context) => evaluateExpression(parseExpression(source), context);
module.exports = { LIMITS, PRECEDENCE, parseExpression, evaluateExpression, expression };
