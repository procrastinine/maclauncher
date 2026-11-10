const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Every icon's drawing is centered in its 24-unit view box, so icon buttons
// look centered wherever they are used.
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/src/ui/icons.tsx'), 'utf8');

function pathBounds(d) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g);
  let i = 0, command = '', x = 0, y = 0, startX = 0, startY = 0, lastControl = null;
  const points = [];
  const number = () => Number(tokens[i++]);
  const add = (px, py) => points.push([px, py]);
  const cubic = (x0, y0, x1, y1, x2, y2, x3, y3) => { for (let t = 0; t <= 1; t += 1 / 64) {
    const u = 1 - t; add(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3); } };
  const arc = (x0, y0, rx, ry, angle, large, sweep, x1, y1) => {
    const phi = angle * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (x0 - x1) / 2, dy = (y0 - y1) / 2, xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
    rx = Math.abs(rx); ry = Math.abs(ry); const scale = xp * xp / (rx * rx) + yp * yp / (ry * ry);
    if (scale > 1) { rx *= Math.sqrt(scale); ry *= Math.sqrt(scale); }
    const sign = large === sweep ? -1 : 1, num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
    const factor = sign * Math.sqrt(Math.max(0, num / (rx * rx * yp * yp + ry * ry * xp * xp)));
    const cxp = factor * rx * yp / ry, cyp = -factor * ry * xp / rx;
    const cx = cos * cxp - sin * cyp + (x0 + x1) / 2, cy = sin * cxp + cos * cyp + (y0 + y1) / 2;
    const angleOf = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const start = angleOf(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
    let delta = angleOf((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
    if (!sweep && delta > 0) delta -= 2 * Math.PI; else if (sweep && delta < 0) delta += 2 * Math.PI;
    for (let t = 0; t <= 1; t += 1 / 64) { const a = start + delta * t;
      add(cx + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin, cy + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos); }
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) command = tokens[i++];
    const relative = command === command.toLowerCase(), ox = relative ? x : 0, oy = relative ? y : 0;
    switch (command.toUpperCase()) {
      case 'M': x = ox + number(); y = oy + number(); startX = x; startY = y; add(x, y); command = relative ? 'l' : 'L'; lastControl = null; break;
      case 'L': x = ox + number(); y = oy + number(); add(x, y); lastControl = null; break;
      case 'H': x = (relative ? x : 0) + number(); add(x, y); lastControl = null; break;
      case 'V': y = (relative ? y : 0) + number(); add(x, y); lastControl = null; break;
      case 'C': { const x1 = ox + number(), y1 = oy + number(), x2 = ox + number(), y2 = oy + number(), x3 = ox + number(), y3 = oy + number();
        cubic(x, y, x1, y1, x2, y2, x3, y3); x = x3; y = y3; lastControl = [x2, y2]; break; }
      case 'S': { const x1 = lastControl ? 2 * x - lastControl[0] : x, y1 = lastControl ? 2 * y - lastControl[1] : y;
        const x2 = ox + number(), y2 = oy + number(), x3 = ox + number(), y3 = oy + number();
        cubic(x, y, x1, y1, x2, y2, x3, y3); x = x3; y = y3; lastControl = [x2, y2]; break; }
      case 'A': { const rx = number(), ry = number(), angle = number(), large = number(), sweep = number(), x1 = ox + number(), y1 = oy + number();
        arc(x, y, rx, ry, angle, large, sweep, x1, y1); x = x1; y = y1; lastControl = null; break; }
      case 'Z': x = startX; y = startY; lastControl = null; break;
      default: throw new Error(`Unsupported path command ${command}`);
    }
  }
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function rectBounds(attributes) {
  const value = name => Number(attributes.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1] || 0);
  const x = value('x'), y = value('y');
  return { minX: x, maxX: x + value('width'), minY: y, maxY: y + value('height') };
}

function union(boxes) {
  return boxes.reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX), minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY) }));
}

// Each icon's glyph is the union of its paths and rectangles; an icon whose path
// depends on a prop is checked once per variant.
function iconGlyphs() {
  const icons = [];
  for (const match of source.matchAll(/export function (\w+Icon)\b([\s\S]*?)\n}\n/g)) {
    const [, name, body] = match, shared = [], variants = [];
    for (const found of body.matchAll(/\bd=(?:"([^"]+)"|\{[^?]*\?\s*"([^"]+)"\s*:\s*"([^"]+)"\})/g)) {
      if (found[1]) shared.push(pathBounds(found[1]));
      else variants.push([`${name} (first)`, pathBounds(found[2])], [`${name} (second)`, pathBounds(found[3])]);
    }
    for (const rect of body.matchAll(/<rect\b([^>]*)>/g)) shared.push(rectBounds(rect[1]));
    if (variants.length) icons.push(...variants.map(([variant, box]) => [variant, union([box, ...shared])]));
    else if (shared.length) icons.push([name, union(shared)]);
  }
  return icons;
}

test('every icon is centered in its view box', () => {
  const icons = iconGlyphs();
  assert.ok(icons.length >= 9, `found ${icons.length} icons`);
  const centers = icons.map(([name, box]) => ({ name, x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2, box }));
  if (process.env.ICON_CENTERS) console.log(JSON.stringify(centers.map(({ name, x, y, box }) => ({ name, x: +x.toFixed(2), y: +y.toFixed(2),
    box: [box.minX, box.maxX, box.minY, box.maxY].map(value => +value.toFixed(2)) }))));
  for (const { name, x, y } of centers) {
    assert.ok(Math.abs(x - 12) <= 0.25, `${name} is centered horizontally (${x.toFixed(2)})`);
    assert.ok(Math.abs(y - 12) <= 0.25, `${name} is centered vertically (${y.toFixed(2)})`);
  }
});
