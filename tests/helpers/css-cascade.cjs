"use strict";
// The value a stylesheet gives one element's property after the cascade, for
// layout checks that a later rule of equal specificity would otherwise defeat.
// The element is a chain of { tag, classes, attributes } from an ancestor down
// to the element itself. Rules with interactive or structural pseudo-classes
// (:hover, :has, :first-child and the like) or sibling combinators describe
// other states and do not match. @media blocks apply when `media(query)` is
// true; by default width queries are read against a 1280 px wide window.

function blocks(css) {
  const rules = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const parse = (start, end, media) => {
    let index = start;
    while (index < end) {
      const open = text.indexOf("{", index);
      if (open < 0 || open >= end) break;
      const prelude = text.slice(index, open).trim();
      let depth = 1, close = open + 1;
      for (; close < end && depth; close++) {
        if (text[close] === "{") depth++;
        else if (text[close] === "}") depth--;
      }
      const body = text.slice(open + 1, close - 1);
      if (prelude.startsWith("@media")) parse(open + 1, close - 1, [...media, prelude.slice(6).trim()]);
      else if (!prelude.startsWith("@")) rules.push({ selectors: splitTop(prelude, ","), body, media });
      index = close;
    }
  };
  parse(0, text.length, []);
  return rules;
}

function splitTop(value, separator) {
  const parts = [];
  let depth = 0, current = "";
  for (const character of value) {
    if (character === "(" || character === "[") depth++;
    if (character === ")" || character === "]") depth--;
    if (character === separator && depth === 0) { parts.push(current.trim()); current = ""; }
    else current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function declarations(body) {
  return splitTop(body, ";").map(item => {
    const colon = item.indexOf(":");
    if (colon < 0) return null;
    const value = item.slice(colon + 1).trim();
    return { property: item.slice(0, colon).trim().toLowerCase(), value: value.replace(/\s*!important$/, ""), important: /!important$/.test(value) };
  }).filter(Boolean);
}

// One compound selector, such as `div.a.b[open]:not(.c)`, as tests on one element.
function compound(text) {
  const tests = [], specificity = [0, 0, 0];
  const pattern = /(\*)|([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:([~|^$*]?=)"?([^"\]]*)"?)?\]|::?([\w-]+)(?:\(((?:[^()]|\([^()]*\))*)\))?/y;
  let index = 0;
  while (index < text.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(text);
    if (!match) return null;
    index = pattern.lastIndex;
    const [, star, tag, className, id, attribute, operator, attributeValue, pseudo, argument] = match;
    if (star) continue;
    if (tag) { specificity[2]++; tests.push(node => node.tag === tag.toLowerCase()); }
    else if (className) { specificity[1]++; tests.push(node => (node.classes || []).includes(className)); }
    else if (id) { specificity[0]++; tests.push(node => node.id === id); }
    else if (attribute) {
      specificity[1]++;
      tests.push(node => {
        const actual = node.attributes?.[attribute];
        if (actual === undefined) return false;
        return !operator || operator === "=" && String(actual) === attributeValue;
      });
    } else if (pseudo === "not" && argument !== undefined) {
      const inner = splitTop(argument, ",").map(compound);
      if (inner.some(item => !item)) return null;
      const widest = inner.reduce((best, item) => compare(item.specificity, best) > 0 ? item.specificity : best, [0, 0, 0]);
      widest.forEach((count, place) => { specificity[place] += count; });
      tests.push(node => !inner.some(item => item.matches(node)));
    } else return null;
  }
  return { specificity, matches: node => tests.every(test => test(node)) };
}

function selector(text) {
  const tokens = text.replace(/\s*>\s*/g, " > ").trim().split(/\s+/);
  if (tokens.some(token => token === "+" || token === "~" || /[+~]/.test(token.replace(/\[[^\]]*\]|\([^)]*\)/g, "")))) return null;
  const parts = [];
  let combinator = " ";
  for (const token of tokens) {
    if (token === ">") { combinator = ">"; continue; }
    const part = compound(token);
    if (!part) return null;
    parts.push({ ...part, combinator });
    combinator = " ";
  }
  const specificity = parts.reduce((total, part) => total.map((count, place) => count + part.specificity[place]), [0, 0, 0]);
  const matches = chain => {
    const match = (partIndex, nodeIndex) => {
      if (!parts[partIndex].matches(chain[nodeIndex])) return false;
      if (partIndex === 0) return true;
      if (parts[partIndex].combinator === ">") return nodeIndex > 0 && match(partIndex - 1, nodeIndex - 1);
      for (let ancestor = nodeIndex - 1; ancestor >= 0; ancestor--) if (match(partIndex - 1, ancestor)) return true;
      return false;
    };
    return match(parts.length - 1, chain.length - 1);
  };
  return { specificity, matches };
}

function compare(left, right) {
  for (let place = 0; place < 3; place++) if (left[place] !== right[place]) return left[place] - right[place];
  return 0;
}

function widthMedia(width) {
  return query => query.split(/\s+and\s+/).every(condition => {
    const match = /\((min|max)-width:\s*(\d+)px\)/.exec(condition);
    if (match) return match[1] === "min" ? width >= Number(match[2]) : width <= Number(match[2]);
    return false;
  });
}

const SIDES = ["top", "right", "bottom", "left"];
function sideValue(shorthand, side) {
  const values = splitTop(shorthand, " ").filter(Boolean);
  const [top, right = top, bottom = top, left = right] = values;
  return { top, right, bottom, left }[side];
}

// Each declaration that sets `property`, read through its shorthand.
function contributions(property, list) {
  const found = [];
  const box = /^(padding|margin)-(top|right|bottom|left)$/.exec(property);
  for (const item of list) {
    if (item.property === property) found.push(item);
    else if (box && item.property === box[1]) found.push({ ...item, value: sideValue(item.value, box[2]) });
    else if (/^border-(top|right|bottom|left)$/.test(property) && item.property === "border") found.push(item);
  }
  return found;
}

function computedValue(css, chain, property, { width = 1280, media = widthMedia(width) } = {}) {
  let winner = null, order = 0;
  for (const rule of blocks(css)) {
    order++;
    if (!rule.media.every(media)) continue;
    const found = contributions(property, declarations(rule.body));
    if (!found.length) continue;
    for (const text of rule.selectors) {
      const parsed = selector(text);
      if (!parsed || !parsed.matches(chain)) continue;
      for (const item of found) {
        const candidate = { value: item.value, important: item.important, specificity: parsed.specificity, order, selector: text };
        const ranked = winner && compare(candidate.specificity, winner.specificity);
        // Importance first, then specificity, then the later declaration.
        if (!winner || candidate.important && !winner.important
          || candidate.important === winner.important && (ranked > 0 || ranked === 0 && candidate.order >= winner.order)) winner = candidate;
      }
    }
  }
  return winner;
}

module.exports = { computedValue, SIDES };
