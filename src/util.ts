export const USER_AGENT = "WardogsTelegramBot/1.0";
export const DAY_MS = 86_400_000;
export const MINUS = "−";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

const integer = new Intl.NumberFormat("uk-UA");
const compactNumber = new Intl.NumberFormat("uk-UA", { notation: "compact", maximumFractionDigits: 1 });

export const formatNumber = (n: number): string => integer.format(Math.round(n));
export const formatMoney = (n: number): string => `$${formatNumber(n)}`;
export const formatCompact = (n: number): string => compactNumber.format(n);

export function formatMoneyDelta(delta: number): string {
  return `${delta >= 0 ? "+" : MINUS}${formatMoney(Math.abs(delta))}`;
}

export function formatPercent(from: number, to: number): string {
  const pct = ((to - from) / from) * 100;
  return `${pct >= 0 ? "+" : MINUS}${Math.abs(pct).toFixed(1).replace(".", ",")}%`;
}

export const formatDayLong = (ts: number): string =>
  new Intl.DateTimeFormat("uk-UA", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(ts);

export const formatDayShort = (ts: number): string =>
  new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "short", timeZone: "UTC" }).format(ts).replace(".", "");

export function startOfUtcDay(date = new Date()): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function exclusive<T>(fn: () => Promise<T>): () => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return () => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };
}
