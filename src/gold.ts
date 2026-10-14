import { askText } from "./openai.js";
import {
  USER_AGENT,
  escapeHtml,
  formatDayLong,
  formatDayShort,
  formatMoney,
  formatMoneyDelta,
  formatPercent,
  startOfUtcDay,
} from "./util.js";

const GOLD_PAGE_URL = "https://wardogstats.app/gold";
export const GOLD_DAYS = 10;

export interface GoldPoint {
  /** полночь UTC дня, с которого действует курс */
  ts: number;
  /** cash за 1 золотой слиток */
  value: number;
}

export interface GoldReport {
  /** последние GOLD_DAYS дней по возрастанию даты */
  points: GoldPoint[];
  latest: GoldPoint;
  prev?: GoldPoint;
  first: GoldPoint;
  min: GoldPoint;
  max: GoldPoint;
}

/**
 * Курс собирает сообщество (MetaForge), wardogstats.app встраивает всю историю
 * в страницу как массив {"ts":…,"value":…} — его и вытаскиваем.
 */
export async function fetchGoldHistory(): Promise<GoldPoint[]> {
  const res = await fetch(GOLD_PAGE_URL, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`wardogstats.app ответил ${res.status}`);
  const html = await res.text();

  const byTs = new Map<number, number>();
  for (const m of html.matchAll(/\\?"ts\\?":(\d+),\\?"value\\?":(\d+)/g)) {
    byTs.set(Number(m[1]), Number(m[2]));
  }
  if (byTs.size === 0) throw new Error("Не нашёл курс на wardogstats.app: похоже, поменялась вёрстка страницы");

  return [...byTs].map(([ts, value]) => ({ ts, value })).sort((a, b) => a.ts - b.ts);
}

export function buildGoldReport(history: GoldPoint[]): GoldReport {
  const points = history.slice(-GOLD_DAYS);
  const byValue = [...points].sort((a, b) => a.value - b.value);
  return {
    points,
    latest: points[points.length - 1]!,
    prev: points.length > 1 ? points[points.length - 2] : undefined,
    first: points[0]!,
    min: byValue[0]!,
    max: byValue[byValue.length - 1]!,
  };
}

export const isTodaysRate = (report: GoldReport): boolean => report.latest.ts >= startOfUtcDay();

const trend = (from: number, to: number): string => (to > from ? "📈" : to < from ? "📉" : "➖");

function changeLine(label: string, from: GoldPoint, to: GoldPoint): string {
  if (from.value === to.value) return `${label}: ➖ без змін`;
  return `${label}: ${trend(from.value, to.value)} ${formatMoneyDelta(to.value - from.value)} (${formatPercent(from.value, to.value)})`;
}

export function goldCaption(report: GoldReport, quip?: string): string {
  const { latest, prev, first, min, max } = report;
  const lines = [
    `🪙 <b>Курс золота WARDOGS</b> · ${formatDayLong(latest.ts)}`,
    "",
    `1 злиток = <b>${formatMoney(latest.value)}</b>`,
  ];
  if (prev) lines.push(changeLine("За добу", prev, latest));
  if (first !== latest) lines.push(changeLine(`За ${report.points.length} дн.`, first, latest));
  lines.push(
    `Мін: ${formatMoney(min.value)} (${formatDayShort(min.ts)}) · Макс: ${formatMoney(max.value)} (${formatDayShort(max.ts)})`,
  );
  if (quip) lines.push("", `<i>${escapeHtml(quip)}</i>`);
  lines.push("", "Курс змінюється о 00:00 UTC");
  return lines.join("\n");
}

/** Короткая шутка к посту от GPT. Курс выше — слитки дороже. */
export function goldQuip(report: GoldReport): Promise<string> {
  const history = report.points.map((p) => `${formatDayShort(p.ts)}: ${formatMoney(p.value)}`).join("\n");
  return askText(
    [
      "Ти ведеш україномовну Telegram-групу про шутер WARDOGS.",
      "У грі зароблений cash обмінюють на золоті злитки за курсом, який змінюється раз на добу.",
      "Курс виріс — злитки подорожчали, купувати невигідно. Курс упав — злитки подешевшали, саме час міняти cash.",
      "Напиши одну коротку смішну фразу (до 120 символів) українською про сьогоднішній курс для гравців.",
      "Без лапок і хештегів, максимум один емодзі. Не повторюй цифри дослівно.",
    ].join(" "),
    `Курс за останні дні (cash за 1 злиток):\n${history}`,
  );
}
