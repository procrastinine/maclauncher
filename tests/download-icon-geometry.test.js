// Owner, 11-17 7:24 PM, of the Runtimes download icon: "Look at download icon in runtimes, especially the linewidths
// and alignments. It is ugly as hell, fix it." The old glyph had a 1-unit shaft beside 2-unit arrow arms and tray,
// and its shaft sat half a unit left of the arrow's tip. These checks read the drawing itself: one stroke width, the
// set's weight at the 18 px icon box, straight edges on the 2x device-pixel grid, and the drawing centred in its box.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { computedValue } = require('./helpers/css-cascade.cjs');

const renderer = path.join(__dirname, '../src/renderer/src/ui');
const icons = fs.readFileSync(path.join(renderer, 'icons.tsx'), 'utf8');
const css = fs.readFileSync(path.join(renderer, 'styles.css'), 'utf8');

function downloadIcon() {
  const start = icons.indexOf('export function DownloadIcon');
  assert.ok(start >= 0, 'icons.tsx defines DownloadIcon');
  const body = icons.slice(start, icons.indexOf('\nexport function', start + 1));
  const attribute = (source, name) => new RegExp(`${name}="([^"]*)"`).exec(source)?.[1];
  const paths = [...body.matchAll(/<path\b([^>]*)\/>/g)].map(match => match[1]);
  return { viewBox: attribute(body, 'viewBox'), paths: paths.map(source => ({ d: attribute(source, 'd'), fill: attribute(source, 'fill'),
    stroke: attribute(source, 'stroke'), strokeWidth: attribute(source, 'strokeWidth'), join: attribute(source, 'strokeLinejoin'),
    cap: attribute(source, 'strokeLinecap') })) };
}

// The path's straight segments, one list per subpath; supports M, L, H and V, absolute and relative.
function subpaths(d) {
  const tokens = d.match(/[MLHVmlhv]|-?\d*\.?\d+/g), result = [];
  let index = 0, x = 0, y = 0, command = null, current = null;
  while (index < tokens.length) {
    if (/[A-Za-z]/.test(tokens[index])) command = tokens[index++];
    const number = () => Number(tokens[index++]);
    const relative = command === command.toLowerCase(), kind = command.toUpperCase();
    let nx = x, ny = y;
    if (kind === 'M' || kind === 'L') { nx = number() + (relative ? x : 0); ny = number() + (relative ? y : 0); }
    else if (kind === 'H') nx = number() + (relative ? x : 0);
    else if (kind === 'V') ny = number() + (relative ? y : 0);
    else throw new Error(`unsupported path command ${command}`);
    if (kind === 'M') { current = []; result.push(current); command = relative ? 'l' : 'L'; }
    else current.push([x, y, nx, ny]);
    x = nx; y = ny;
  }
  return result;
}

// Every corner of the stroked outline: each segment's butt-capped rectangle and each miter tip.
function outline(segments, half) {
  const points = [];
  for (const [x1, y1, x2, y2] of segments) {
    const length = Math.hypot(x2 - x1, y2 - y1), nx = -(y2 - y1) / length * half, ny = (x2 - x1) / length * half;
    points.push([x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny]);
  }
  for (let index = 1; index < segments.length; index++) {
    const [ax, ay, vx, vy] = segments[index - 1], [, , bx, by] = segments[index];
    const u = [(ax - vx) / Math.hypot(ax - vx, ay - vy), (ay - vy) / Math.hypot(ax - vx, ay - vy)];
    const w = [(bx - vx) / Math.hypot(bx - vx, by - vy), (by - vy) / Math.hypot(bx - vx, by - vy)];
    const angle = Math.acos(u[0] * w[0] + u[1] * w[1]), bisector = [-(u[0] + w[0]), -(u[1] + w[1])], size = Math.hypot(...bisector);
    points.push([vx + bisector[0] / size * half / Math.sin(angle / 2), vy + bisector[1] / size * half / Math.sin(angle / 2)]);
  }
  return points;
}

const onHalfPixel = value => Math.abs(value * 2 - Math.round(value * 2)) < 1e-9;

test('the download icon is one 1.5 px stroke on the 18 px icon box, straight edges on whole 2x device pixels, centred', () => {
  const icon = downloadIcon();
  assert.equal(icon.viewBox, '0 0 18 18', 'drawn in the units of the 18 px box it renders in');
  assert.equal(icon.paths.length, 1, 'one path, so one stroke width');
  const [shape] = icon.paths;
  // The set draws 2-unit strokes in a 24-unit box; at 18 px that is 1.5 px.
  assert.equal(Number(shape.strokeWidth), 2 / 24 * 18);
  assert.equal(shape.fill, 'none');
  assert.equal(shape.stroke, 'currentColor');
  assert.equal(shape.join, 'miter');
  assert.equal(shape.cap, 'butt');
  const half = Number(shape.strokeWidth) / 2, parts = subpaths(shape.d);
  for (const [x1, y1, x2, y2] of parts.flat()) {
    if (x1 === x2) for (const value of [x1 - half, x1 + half, y1, y2]) assert.ok(onHalfPixel(value), `vertical stroke edge ${value} on the 2x grid`);
    if (y1 === y2) for (const value of [y1 - half, y1 + half, x1, x2]) assert.ok(onHalfPixel(value), `horizontal stroke edge ${value} on the 2x grid`);
  }
  const points = parts.flatMap(segments => outline(segments, half));
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  const box = { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
  assert.ok(box.left >= 0 && box.top >= 0 && box.right <= 18 && box.bottom <= 18, 'inside the box');
  assert.ok(Math.abs((box.top + box.bottom) / 2 - 9) < 1e-9, `vertically centred: ${box.top}..${box.bottom}`);
  assert.ok(Math.abs((box.left + box.right) / 2 - 9) <= 0.25 + 1e-9, `horizontally centred within a quarter pixel: ${box.left}..${box.right}`);
  // The shaft runs down the arrow's axis, through the tip of its head.
  const [shaft, head] = parts;
  assert.equal(shaft.length, 1);
  assert.equal(shaft[0][0], shaft[0][2], 'the shaft is vertical');
  assert.equal(head[0][2], shaft[0][0], 'the head\'s tip is on the shaft\'s axis');
  assert.equal(head[0][3], shaft[0][3], 'the shaft ends at the tip');
  assert.ok(Math.abs((head[0][0] + head[1][2]) / 2 - shaft[0][0]) < 1e-9, 'the head is symmetric about the shaft');
});

test('the download icon renders on its grid wherever it appears', () => {
  // The Runtimes Downloads button draws its glyph in the 18 px icon box, as every icon button does.
  assert.equal(computedValue(css, [{ tag: ':root' }], '--icon-size')?.value ?? /--icon-size: (\d+px)/.exec(css)?.[1], '18px');
  const toggle = [{ tag: 'button', classes: ['btn', 'iconOnly', 'runtimeDownloadToggle'] }];
  assert.equal(computedValue(css, toggle, 'font-size')?.value, 'var(--icon-size)');
  assert.equal(computedValue(css, [...toggle, { tag: 'svg' }], 'width')?.value, '1em');
  // An explicit size elsewhere is a whole multiple of the 18 px grid.
  const components = path.join(renderer, 'components');
  for (const file of fs.readdirSync(components).filter(name => name.endsWith('.tsx'))) {
    for (const match of fs.readFileSync(path.join(components, file), 'utf8').matchAll(/<DownloadIcon\b([^>]*)\/>/g)) {
      const size = /size="(\d+)"/.exec(match[1])?.[1];
      if (size) assert.equal(Number(size) % 18, 0, `${file}: DownloadIcon size ${size} is a multiple of 18`);
    }
  }
});
