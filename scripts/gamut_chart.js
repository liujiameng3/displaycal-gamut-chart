#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function usage(exitCode = 0) {
  const text = `Usage:
  node gamut_chart.js --input REPORT.html --target srgb|dci-p3|adobe-rgb \\
    --mode "sRGB Mode" --model Q50X4 --metric coverage|volume \\
    --output OUTPUT_BASE [--shape target|measured|intersection]

Outputs OUTPUT_BASE.svg, OUTPUT_BASE.png, and OUTPUT_BASE.json.
Coverage charts default to the target reference triangle. Volume charts default to
the measured triangle. Use --shape intersection for the literal covered polygon.`;
  console.log(text);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') usage(0);
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument: ${argv[i]}`);
    const key = argv[i].slice(2);
    const value = argv[++i];
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    out[key] = value;
  }
  return out;
}

const TARGETS = {
  srgb: {
    name: 'sRGB',
    primaries: { R: [0.6400, 0.3300], G: [0.3000, 0.6000], B: [0.1500, 0.0600] },
  },
  'dci-p3': {
    name: 'DCI-P3',
    primaries: { R: [0.6800, 0.3200], G: [0.2650, 0.6900], B: [0.1500, 0.0600] },
  },
  'adobe-rgb': {
    name: 'Adobe RGB',
    primaries: { R: [0.6400, 0.3300], G: [0.2100, 0.7100], B: [0.1500, 0.0600] },
  },
};

function canonicalTarget(value) {
  const key = String(value || '').toLowerCase().replace(/[_ ]+/g, '-');
  if (key === 'p3' || key === 'display-p3') return 'dci-p3';
  if (key === 'adobergb') return 'adobe-rgb';
  if (!TARGETS[key]) throw new Error(`Unsupported target gamut: ${value}`);
  return key;
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#([0-9]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function inputValue(html, name) {
  const tags = html.match(/<input\b[\s\S]*?\/?>/gi) || [];
  for (const tag of tags) {
    const nm = tag.match(/\bname\s*=\s*["']([^"']+)["']/i);
    if (!nm || nm[1] !== name) continue;
    const vm = tag.match(/\bvalue\s*=\s*"([\s\S]*?)"/i) || tag.match(/\bvalue\s*=\s*'([\s\S]*?)'/i);
    if (!vm) throw new Error(`${name} input has no value attribute`);
    return decodeHtmlEntities(vm[1]);
  }
  throw new Error(`Could not find ${name} in the DisplayCAL report`);
}

function parseDisplayCal(html) {
  const ti3 = inputValue(html, 'FF_data_in');
  const fm = ti3.match(/BEGIN_DATA_FORMAT\s+([\s\S]*?)\s+END_DATA_FORMAT/i);
  const dm = ti3.match(/BEGIN_DATA\s+([\s\S]*?)\s+END_DATA/i);
  if (!fm || !dm) throw new Error('Malformed DisplayCAL CTI3 data');
  const fields = fm[1].trim().split(/\s+/);
  const required = ['RGB_R', 'RGB_G', 'RGB_B', 'XYZ_X', 'XYZ_Y', 'XYZ_Z'];
  const idx = Object.fromEntries(required.map(k => [k, fields.indexOf(k)]));
  for (const k of required) if (idx[k] < 0) throw new Error(`Missing field ${k}`);
  const rows = dm[1].trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const cols = line.split(/\s+/).map(Number);
    return {
      rgb: [cols[idx.RGB_R], cols[idx.RGB_G], cols[idx.RGB_B]],
      xyz: [cols[idx.XYZ_X], cols[idx.XYZ_Y], cols[idx.XYZ_Z]],
    };
  });
  const near = (a, b) => Math.abs(a - b) < 0.01;
  const find = rgb => rows.find(row => row.rgb.every((v, i) => near(v, rgb[i])));
  const patches = {
    K: find([0, 0, 0]), R: find([100, 0, 0]),
    G: find([0, 100, 0]), B: find([0, 0, 100]),
  };
  for (const [k, row] of Object.entries(patches)) if (!row) throw new Error(`Missing ${k} measurement patch`);
  const reportTitle = (html.match(/id=["']reporttitle["'][^>]*>([\s\S]*?)<\/h2>/i) || [])[1] || '';
  const model = decodeHtmlEntities(reportTitle.replace(/<[^>]+>/g, '')).split('@')[0].trim();
  return { patches, model };
}

function xy(xyz) {
  const sum = xyz[0] + xyz[1] + xyz[2];
  if (!(sum > 0)) throw new Error('Invalid XYZ value');
  return [xyz[0] / sum, xyz[1] / sum];
}

function signedArea(poly) {
  return poly.reduce((sum, p, i) => {
    const q = poly[(i + 1) % poly.length];
    return sum + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2;
}

function area(poly) { return Math.abs(signedArea(poly)); }
function ccw(poly) { return signedArea(poly) >= 0 ? poly : [...poly].reverse(); }

function polygonIntersection(subject, clip) {
  let output = ccw(subject);
  const boundary = ccw(clip);
  const inside = (p, a, b) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= -1e-12;
  const crossing = (p1, p2, a, b) => {
    const [x1, y1] = p1, [x2, y2] = p2, [x3, y3] = a, [x4, y4] = b;
    const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    return [
      ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / d,
      ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / d,
    ];
  };
  for (let j = 0; j < boundary.length; j++) {
    const input = output;
    output = [];
    if (!input.length) break;
    const a = boundary[j], b = boundary[(j + 1) % boundary.length];
    let s = input[input.length - 1];
    for (const e of input) {
      if (inside(e, a, b)) {
        if (!inside(s, a, b)) output.push(crossing(s, e, a, b));
        output.push(e);
      } else if (inside(s, a, b)) output.push(crossing(s, e, a, b));
      s = e;
    }
  }
  return output;
}

function loadSharp() {
  try { return require('sharp'); } catch (_) {}
  const roots = String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
  for (const root of roots) {
    try { return require(path.join(root, 'sharp')); } catch (_) {}
  }
  throw new Error('The sharp package is required for PNG output. Set NODE_PATH to the bundled Node modules directory.');
}

async function render({ model, mode, target, metric, shape, measured, intersection, metrics, outputBase }) {
  const sharp = loadSharp();
  const W = 1400, H = 1400;
  const plot = { left: 180, top: 160, scale: 1350, maxX: 0.75, maxY: 0.85 };
  plot.width = plot.maxX * plot.scale;
  plot.height = plot.maxY * plot.scale;
  const ciePath = path.join(__dirname, '..', 'assets', 'CIE_cc_1931_2deg.csv');
  const locus = fs.readFileSync(ciePath, 'utf8').trim().split(/\r?\n/).map(line => {
    const [w, x, y] = line.split(',').map(Number);
    return { w, xy: [x, y] };
  }).filter(p => p.w >= 380 && p.w <= 700);
  const pt = ([x, y]) => [plot.left + x * plot.scale, plot.top + (plot.maxY - y) * plot.scale];
  const n = v => Number(v).toFixed(1);
  const targetPoly = ['R', 'G', 'B'].map(k => target.primaries[k]);
  const measuredPoly = ['R', 'G', 'B'].map(k => measured[k]);
  const chartPoly = shape === 'measured' ? measuredPoly : shape === 'intersection' ? intersection : targetPoly;
  const chartPoints = chartPoly.map(p => pt(p).map(n).join(',')).join(' ');
  const first = pt(locus[0].xy);
  const locusPath = locus.map((p, i) => `${i ? 'L' : 'M'} ${n(pt(p.xy)[0])} ${n(pt(p.xy)[1])}`).join(' ') + ` L ${n(first[0])} ${n(first[1])} Z`;

  const fieldWidth = Math.ceil(plot.width), fieldHeight = Math.ceil(plot.height);
  const raw = Buffer.alloc(fieldWidth * fieldHeight * 4);
  const gamma = c => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  for (let py = 0; py < fieldHeight; py++) {
    const y = plot.maxY - (py + 0.5) / plot.scale;
    for (let px = 0; px < fieldWidth; px++) {
      const x = (px + 0.5) / plot.scale;
      let r = 0, g = 0, b = 0;
      if (y > 0.0001 && x >= 0 && x + y <= 1.0001) {
        const X = x / y, Y = 1, Z = (1 - x - y) / y;
        r = Math.max(0, 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z);
        g = Math.max(0, -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z);
        b = Math.max(0, 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z);
        const peak = Math.max(r, g, b);
        if (peak > 1) { r /= peak; g /= peak; b /= peak; }
        r = gamma(Math.min(1, r)); g = gamma(Math.min(1, g)); b = gamma(Math.min(1, b));
      }
      const i = (py * fieldWidth + px) * 4;
      raw[i] = Math.round(r * 150); raw[i + 1] = Math.round(g * 150);
      raw[i + 2] = Math.round(b * 150); raw[i + 3] = 255;
    }
  }
  const field = await sharp(raw, { raw: { width: fieldWidth, height: fieldHeight, channels: 4 } }).png().toBuffer();
  const fieldUri = `data:image/png;base64,${field.toString('base64')}`;

  let grid = '';
  for (let x = 0; x <= 0.7001; x += 0.1) {
    const X = pt([x, 0])[0];
    grid += `<line x1="${n(X)}" y1="${plot.top}" x2="${n(X)}" y2="${n(plot.top + plot.height)}" class="grid"/>`;
    grid += `<text x="${n(X)}" y="${n(plot.top + plot.height + 43)}" class="tick" text-anchor="middle">${x.toFixed(1)}</text>`;
  }
  for (let y = 0; y <= 0.8001; y += 0.1) {
    const Y = pt([0, y])[1];
    grid += `<line x1="${plot.left}" y1="${n(Y)}" x2="${n(plot.left + plot.width)}" y2="${n(Y)}" class="grid"/>`;
    grid += `<text x="${plot.left - 27}" y="${n(Y + 7)}" class="tick" text-anchor="end">${y.toFixed(1)}</text>`;
  }

  const labelPrimaries = shape === 'measured' ? measured : target.primaries;
  const positions = target.name === 'Adobe RGB'
    ? { G: [500, 285], R: [1088, 798], B: [430, 1165] }
    : target.name === 'DCI-P3'
      ? { G: [575, 310], R: [1130, 805], B: [430, 1165] }
      : { G: [625, 430], R: [1088, 798], B: [430, 1165] };
  const vertex = (k) => {
    const [cx, cy] = pt(labelPrimaries[k]);
    const [lx, ly] = positions[k];
    const color = { R: '#ff526d', G: '#46e08c', B: '#5da8ff' }[k];
    const [x, y] = labelPrimaries[k];
    return `<g><circle cx="${n(cx)}" cy="${n(cy)}" r="10" fill="#07111c" stroke="#fff" stroke-width="4"/><text x="${lx}" y="${ly}" class="vertex-name" fill="${color}">${k}</text><text x="${lx}" y="${ly + 31}" class="vertex-coord">x ${x.toFixed(4)}  ·  y ${y.toFixed(4)}</text></g>`;
  };
  const vertexLabels = shape === 'intersection' ? '' : ['G', 'R', 'B'].map(vertex).join('\n');
  const value = metric === 'volume' ? metrics.volume : metrics.coverage;
  const metricLabel = `${target.name} Gamut ${metric === 'volume' ? 'Volume' : 'Coverage'} ${value.toFixed(1)}%`;
  const title = `${model} ${mode} - CIE 1931 xy Chromaticity Diagram`;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#050d16"/><stop offset="1" stop-color="#0a1a29"/></linearGradient><filter id="lineGlow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><filter id="textShadow"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000" flood-opacity=".85"/></filter><clipPath id="plotClip"><rect x="${plot.left}" y="${plot.top}" width="${plot.width}" height="${plot.height}"/></clipPath><clipPath id="locusClip"><path d="${locusPath}"/></clipPath><style>
text{font-family:"Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif}.title{font-size:34px;font-weight:710;fill:#f7fafc;letter-spacing:.25px}.grid{stroke:#d9e7f4;stroke-opacity:.105;stroke-width:1}.tick{font-size:17px;fill:#75899b}.axis{font-size:24px;font-style:italic;fill:#9cb0c1}.vertex-name{font-size:27px;font-weight:820;filter:url(#textShadow)}.vertex-coord{font-family:"Cascadia Mono","Consolas",monospace;font-size:20px;font-weight:600;fill:#eef5fb;filter:url(#textShadow)}.metric-small{font-size:23px;font-weight:680;letter-spacing:.5px;fill:#f1f6fa;filter:url(#textShadow)}.method{font-size:16px;fill:#6f8496}</style></defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/><circle cx="1320" cy="-70" r="400" fill="#1d72a8" opacity=".055"/><text x="150" y="103" class="title">${title}</text>
<g clip-path="url(#plotClip)"><rect x="${plot.left}" y="${plot.top}" width="${plot.width}" height="${plot.height}" fill="#07131f"/><image href="${fieldUri}" x="${plot.left}" y="${plot.top}" width="${plot.width}" height="${plot.height}" clip-path="url(#locusClip)"/><path d="${locusPath}" fill="none" stroke="#c9d7e3" stroke-opacity=".52" stroke-width="3"/><path d="${locusPath}" fill="#020810" fill-opacity=".20" stroke="none"/>${grid}<polygon points="${chartPoints}" fill="none" stroke="#fff" stroke-width="6" stroke-linejoin="round" filter="url(#lineGlow)"/><text x="1160" y="1250" class="metric-small" text-anchor="end">${metricLabel}</text></g>
${vertexLabels}<text x="${n(plot.left + plot.width / 2)}" y="${n(plot.top + plot.height + 90)}" class="axis" text-anchor="middle">x</text><text x="86" y="${n(plot.top + plot.height / 2)}" class="axis" text-anchor="middle" transform="rotate(-90 86 ${n(plot.top + plot.height / 2)})">y</text><text x="150" y="1360" class="method">CIE 1931 2° spectrum locus · black-corrected ${target.name} ${metric} in ${mode}</text></svg>`;

  fs.mkdirSync(path.dirname(outputBase), { recursive: true });
  const svgPath = `${outputBase}.svg`, pngPath = `${outputBase}.png`;
  fs.writeFileSync(svgPath, svg, 'utf8');
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(pngPath);
  return { svgPath, pngPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.target || !args.output) usage(2);
  const targetKey = canonicalTarget(args.target);
  const target = TARGETS[targetKey];
  const metric = String(args.metric || 'coverage').toLowerCase();
  if (!['coverage', 'volume'].includes(metric)) throw new Error('--metric must be coverage or volume');
  const shape = String(args.shape || (metric === 'volume' ? 'measured' : 'target')).toLowerCase();
  if (!['target', 'measured', 'intersection'].includes(shape)) throw new Error('--shape must be target, measured, or intersection');
  const html = fs.readFileSync(path.resolve(args.input), 'utf8');
  const parsed = parseDisplayCal(html);
  const black = parsed.patches.K.xyz;
  const measured = {};
  for (const k of ['R', 'G', 'B']) measured[k] = xy(parsed.patches[k].xyz.map((v, i) => v - black[i]));
  const measuredPoly = ['R', 'G', 'B'].map(k => measured[k]);
  const targetPoly = ['R', 'G', 'B'].map(k => target.primaries[k]);
  const intersection = polygonIntersection(measuredPoly, targetPoly);
  const metrics = {
    coverage: area(intersection) / area(targetPoly) * 100,
    volume: area(measuredPoly) / area(targetPoly) * 100,
  };
  const model = args.model || parsed.model || 'Display';
  const mode = args.mode || `${target.name} Mode`;
  const outputBase = path.resolve(args.output.replace(/\.(png|svg|json)$/i, ''));
  const files = await render({ model, mode, target, metric, shape, measured, intersection, metrics, outputBase });
  const report = {
    input: path.resolve(args.input), model, mode, target: target.name,
    method: 'black-corrected CIE 1931 xy triangle intersection',
    measuredPrimaries: measured, targetPrimaries: target.primaries,
    coveragePercent: metrics.coverage, volumePercent: metrics.volume,
    chartMetric: metric, chartShape: shape, files,
  };
  const jsonPath = `${outputBase}.json`;
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ ...report, files: { ...files, jsonPath } }, null, 2));
}

main().catch(err => { console.error(`Error: ${err.message}`); process.exit(1); });
