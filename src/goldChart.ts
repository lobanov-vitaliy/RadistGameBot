import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import resvg from "@resvg/resvg-js";
import type { GoldPoint, GoldReport } from "./gold.js";
import { escapeHtml, formatDayLong, formatDayShort, formatMoney, formatNumber, formatPercent } from "./util.js";

const FONT_DIR = fileURLToPath(new URL("../assets/fonts/", import.meta.url));
const FONT_FILES = readdirSync(FONT_DIR)
  .filter((f) => f.endsWith(".ttf"))
  .map((f) => FONT_DIR + f);

const W = 1200;
const H = 675;
const PAD = 56;

const DISPLAY = "Russo One";
const TEXT = "PT Sans Narrow";

const COLOR = {
  bone: "#ece6d2",
  dim: "#8d907c",
  gold: "#f5c542",
  // выше курс — слитки дороже, поэтому рост красный
  up: "#ff6b57",
  down: "#5fd38d",
};

function trendColor(from: number, to: number): string {
  return to > from ? COLOR.up : to < from ? COLOR.down : COLOR.dim;
}

/** Треугольник ▲/▼, правый край в x, по центру строки с базовой линией y. */
function triangle(x: number, y: number, size: number, up: boolean, fill: string): string {
  const top = y - size * 0.95;
  const bottom = y - size * 0.1;
  const points = up
    ? `${x - size},${bottom} ${x},${bottom} ${x - size / 2},${top}`
    : `${x - size},${top} ${x},${top} ${x - size / 2},${bottom}`;
  return `<polygon points="${points}" fill="${fill}"/>`;
}

/** Строка изменения, выровненная по правому краю: «+22,9% за добу ▲». */
function changeRow(from: GoldPoint, to: GoldPoint, label: string, y: number, size: number): string {
  const color = trendColor(from.value, to.value);
  const right = W - PAD;
  const text = from.value === to.value ? `без змін ${label}` : `${formatPercent(from.value, to.value)} ${label}`;
  const arrow = from.value === to.value ? "" : triangle(right, y, size * 0.62, to.value > from.value, color);
  const textRight = arrow ? right - size * 0.62 - 10 : right;
  return `<text x="${textRight}" y="${y}" text-anchor="end" font-family="${TEXT}" font-weight="bold" font-size="${size}" fill="${color}">${escapeHtml(text)}</text>${arrow}`;
}

function ingot(x: number, y: number): string {
  return `<g transform="translate(${x} ${y})" filter="url(#glow)">
    <polygon points="0,40 9,11 63,11 72,40" fill="url(#barGold)"/>
    <polygon points="9,11 17,0 55,0 63,11" fill="#fff0b0"/>
    <polygon points="0,40 9,11 14,11 6,40" fill="#ffffff" opacity="0.25"/>
  </g>`;
}

function chart(report: GoldReport): string {
  const { points, latest, max } = report;
  const left = PAD;
  const right = W - PAD;
  const top = 270;
  const base = 572;
  const slot = (right - left) / points.length;
  const barW = Math.min(72, slot * 0.58);
  const usable = base - top - 36;

  const grid = [0.25, 0.5, 0.75, 1]
    .map((k) => {
      const y = base - usable * k;
      return `<line x1="${left}" x2="${right}" y1="${y}" y2="${y}" stroke="#ffffff" stroke-opacity="0.06" stroke-dasharray="4 8"/>`;
    })
    .join("");

  const bars = points
    .map((p, i) => {
      const isToday = p === latest;
      const h = Math.max(6, (p.value / max.value) * usable);
      const cx = left + slot * i + slot / 2;
      const x = cx - barW / 2;
      const y = base - h;
      const bar = isToday
        ? `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="4" fill="url(#barGold)" stroke="#fff3c4" stroke-width="2" filter="url(#glow)"/>`
        : `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="4" fill="url(#barGold)" opacity="0.42"/>`;
      const value = isToday
        ? `<text x="${cx}" y="${y - 14}" text-anchor="middle" font-family="${DISPLAY}" font-size="23" fill="${COLOR.gold}">${formatNumber(p.value)}</text>`
        : `<text x="${cx}" y="${y - 12}" text-anchor="middle" font-family="${TEXT}" font-weight="bold" font-size="21" fill="${COLOR.bone}" opacity="0.8">${formatNumber(p.value)}</text>`;
      const day = isToday
        ? `<text x="${cx}" y="${base + 34}" text-anchor="middle" font-family="${TEXT}" font-weight="bold" font-size="22" letter-spacing="2" fill="${COLOR.gold}">СЬОГОДНІ</text>`
        : `<text x="${cx}" y="${base + 34}" text-anchor="middle" font-family="${TEXT}" font-size="22" fill="${COLOR.dim}">${escapeHtml(formatDayShort(p.ts))}</text>`;
      return bar + value + day;
    })
    .join("");

  const baseline = `<line x1="${left}" x2="${right}" y1="${base}" y2="${base}" stroke="${COLOR.dim}" stroke-opacity="0.6" stroke-width="2"/>`;
  return grid + bars + baseline;
}

export function goldChartSvg(report: GoldReport): string {
  const { latest, prev, first, min, max, points } = report;
  const right = W - PAD;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#252a1b"/>
      <stop offset="1" stop-color="#0d0f09"/>
    </linearGradient>
    <radialGradient id="shine" cx="0.82" cy="0.18" r="0.55">
      <stop offset="0" stop-color="${COLOR.gold}" stop-opacity="0.2"/>
      <stop offset="1" stop-color="${COLOR.gold}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="barGold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffe48f"/>
      <stop offset="0.45" stop-color="#f2b632"/>
      <stop offset="1" stop-color="#8f600c"/>
    </linearGradient>
    <linearGradient id="textGold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff3c2"/>
      <stop offset="0.5" stop-color="#f5c542"/>
      <stop offset="1" stop-color="#d08f17"/>
    </linearGradient>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M40 0H0V40" fill="none" stroke="#ffffff" stroke-opacity="0.035"/>
    </pattern>
    <pattern id="hazard" width="32" height="32" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="32" height="32" fill="#14160f"/>
      <rect width="16" height="32" fill="${COLOR.gold}"/>
    </pattern>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="9" result="blur"/>
      <feColorMatrix in="blur" type="matrix" values="1 0 0 0 0  0 0.8 0 0 0  0 0 0.3 0 0  0 0 0 0.55 0" result="tint"/>
      <feMerge><feMergeNode in="tint"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <rect width="${W}" height="${H}" fill="url(#shine)"/>
  <rect width="${W}" height="10" fill="url(#hazard)"/>

  <text x="${PAD}" y="70" font-family="${TEXT}" font-weight="bold" font-size="22" letter-spacing="5" fill="${COLOR.gold}">WARDOGS · GOLD EXCHANGE</text>
  ${ingot(PAD, 96)}
  <text x="${PAD + 92}" y="136" font-family="${DISPLAY}" font-size="52" fill="${COLOR.bone}">КУРС ЗОЛОТА</text>
  <text x="${PAD}" y="182" font-family="${TEXT}" font-size="28" fill="${COLOR.dim}">${escapeHtml(formatDayLong(latest.ts))} · останні ${points.length} дн.</text>

  <text x="${right}" y="70" text-anchor="end" font-family="${TEXT}" font-weight="bold" font-size="22" letter-spacing="5" fill="${COLOR.dim}">1 ЗЛИВОК</text>
  <text x="${right}" y="146" text-anchor="end" font-family="${DISPLAY}" font-size="76" fill="url(#textGold)" filter="url(#glow)">${formatMoney(latest.value)}</text>
  ${prev ? changeRow(prev, latest, "за добу", 186, 28) : ""}
  ${first !== latest ? changeRow(first, latest, `за ${points.length} дн.`, 218, 22) : ""}

  ${chart(report)}

  <text x="${PAD}" y="${H - 22}" font-family="${TEXT}" font-size="20" fill="${COLOR.dim}">мін ${formatMoney(min.value)} · макс ${formatMoney(max.value)}</text>
</svg>`;
}

export function renderGoldChart(report: GoldReport): Buffer {
  const image = new resvg.Resvg(goldChartSvg(report), {
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: TEXT },
    fitTo: { mode: "width", value: W * 2 },
  });
  return image.render().asPng();
}
