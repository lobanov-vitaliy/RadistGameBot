import { aiEnabled, askJson } from "./openai.js";
import { USER_AGENT, escapeHtml, formatDayShort, truncate } from "./util.js";

const APP_ID = 1867240;
const FEED = "steam_community_announcements";

export interface SteamNewsItem {
  gid: string;
  title: string;
  url: string;
  contents: string;
  date: number;
  feedname: string;
}

export async function fetchSteamNews(count = 10): Promise<SteamNewsItem[]> {
  const url = new URL("https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/");
  url.search = new URLSearchParams({
    appid: String(APP_ID),
    count: String(count),
    maxlength: "0",
    feeds: FEED,
    format: "json",
  }).toString();

  const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Steam News API ответил ${res.status}`);
  const json = (await res.json()) as { appnews?: { newsitems?: SteamNewsItem[] } };
  return json.appnews?.newsitems ?? [];
}

export const steamPostUrl = (item: SteamNewsItem): string =>
  `https://store.steampowered.com/news/app/${APP_ID}/view/${item.gid}`;

const CLAN_IMAGE = "https://clan.akamai.steamstatic.com/images";

export function firstImage(item: SteamNewsItem): string | undefined {
  const m = item.contents.match(/\{STEAM_CLAN_IMAGE\}(\/[^\s"\[\]]+)/);
  return m ? CLAN_IMAGE + m[1] : undefined;
}

interface Block {
  kind: "heading" | "item" | "text";
  text: string;
}

const HEADING = "\u0001";
const ITEM = "\u0002";
const BLOCK_TAGS = /\[\/?(?:p|h[1-6]|list|olist|table|tr|carousel|hr|quote|code)(?:[ =][^\]]*)?\]/gi;
const INLINE_TAGS = /\[\/?(?:b|i|u|s|strike|spoiler|noparse|url|th|td|\*|expand|emoticon)(?:[ =][^\]]*)?\]/gi;

function bbcodeBlocks(bbcode: string): Block[] {
  const lines = bbcode
    .replace(/\[previewyoutube="?([\w-]+)[^\]]*\]\s*\[\/previewyoutube\]/gi, "\n▶️ https://youtu.be/$1\n")
    .replace(/\[img[^\]]*\][^\[]*\[\/img\]/gi, "")
    .replace(/\[video[^\]]*\][\s\S]*?\[\/video\]/gi, "")
    .replace(/\[h[1-6][^\]]*\]/gi, `\n${HEADING}`)
    .replace(/\[\*\]/g, `\n${ITEM}`)
    .replace(BLOCK_TAGS, "\n")
    .replace(INLINE_TAGS, "")
    .split("\n");

  const blocks: Block[] = [];
  let pending: Block["kind"] | undefined;
  for (const raw of lines) {
    let line = raw.trim();
    let kind: Block["kind"] = pending ?? "text";
    if (line.startsWith(HEADING) || line.startsWith(ITEM)) {
      kind = line.startsWith(HEADING) ? "heading" : "item";
      line = line.slice(1).trim();
    } else if (/^[-•]\s+/.test(line)) {
      kind = "item";
      line = line.replace(/^[-•]\s+/, "");
    }
    if (!line) {
      if (raw.includes(HEADING) || raw.includes(ITEM)) pending = kind;
      continue;
    }
    pending = undefined;
    blocks.push({ kind, text: line });
  }
  return blocks;
}

function bbcodeToText(bbcode: string): string {
  return bbcodeBlocks(bbcode)
    .map((b) => (b.kind === "heading" ? `\n## ${b.text}` : b.kind === "item" ? `• ${b.text}` : b.text))
    .join("\n")
    .trim();
}

function collapsible(html: string): string {
  return html.length > 700 ? `<blockquote expandable>${html}</blockquote>` : html;
}

function fit(lines: string[], budget: number): string {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length > budget) {
      out.push("…");
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out.join("\n").trim();
}

function renderBlocks(blocks: Block[]): string[] {
  const lines: string[] = [];
  blocks.forEach((block, i) => {
    const prev = blocks[i - 1];
    const tight = prev && (prev.kind === "heading" || (prev.kind === "item" && block.kind === "item"));
    if (prev && !tight) lines.push("");
    const text = escapeHtml(truncate(block.text, 600));
    lines.push(block.kind === "heading" ? `<b>${text}</b>` : block.kind === "item" ? `• ${text}` : text);
  });
  return lines;
}

type NewsKind = "patch" | "hotfix" | "maintenance" | "news" | "event";

const KIND: Record<NewsKind, { emoji: string; label: string }> = {
  patch: { emoji: "🛠", label: "Оновлення" },
  hotfix: { emoji: "🩹", label: "Хотфікс" },
  maintenance: { emoji: "⏳", label: "Техроботи" },
  news: { emoji: "📰", label: "Новини" },
  event: { emoji: "🎉", label: "Подія" },
};

function header(kind: NewsKind, title: string, item: SteamNewsItem): string {
  const { emoji, label } = KIND[kind];
  return `${emoji} <b>${escapeHtml(truncate(title, 120))}</b>\n<i>${label} · ${formatDayShort(item.date * 1000)}</i>`;
}

const footer = (item: SteamNewsItem): string => `🔗 <a href="${steamPostUrl(item)}">Читати в Steam</a>`;

function plainMessage(item: SteamNewsItem): string {
  const body = fit(renderBlocks(bbcodeBlocks(item.contents)), 3300);
  return [header("news", item.title, item), "", collapsible(body), "", footer(item)].join("\n");
}

interface NewsDigest {
  kind: NewsKind;
  title: string;
  summary: string;
  sections: { emoji: string; title: string; items: string[] }[];
}

const DIGEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "title", "summary", "sections"],
  properties: {
    kind: {
      type: "string",
      enum: Object.keys(KIND),
      description: "patch — патч/оновлення, hotfix — швидкий фікс, maintenance — техроботи/даунтайм, event — івент/сезон, news — усе інше",
    },
    title: { type: "string", description: "Короткий заголовок українською, до 70 символів" },
    summary: { type: "string", description: "Суть поста в 1–3 реченнях" },
    sections: {
      type: "array",
      description: "Зміни, згруповані за змістом. Порожній масив, якщо конкретики немає",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["emoji", "title", "items"],
        properties: {
          emoji: { type: "string", description: "Один емодзі, що пасує до розділу" },
          title: { type: "string", description: "Назва розділу: Нове, Баланс, Виправлення, Техроботи, Відомі проблеми тощо" },
          items: { type: "array", items: { type: "string" }, description: "До 6 пунктів, кожен до 90 символів" },
        },
      },
    },
  },
};

const DIGEST_INSTRUCTIONS = `Ти редактор україномовної Telegram-групи про шутер WARDOGS від студії BULKHEAD.
Тобі дають офіційний пост розробників зі Steam. Перекажи його для гравців: коротко, по суті, живою мовою.

Мова:
- Усе пиши українською: описи, дати, місяці, одиниці часу («1 година», «15 жовтня»).
- Англійською лишай ТІЛЬКИ власні назви: зброю, техніку, мапи, предмети, режими, фракції (M4, T-72, Havoc, Bakurani, FOB, Lonestar).
- Добре: «Wolf-110 — швидкий легкий колісний транспорт». Погано: «Wolf-110 — fast, light wheeled transport».

Структура:
- title: суть поста своїми словами, без префікса «WARDOGS |».
- kind: patch, якщо в пості є патчноути чи список змін, навіть коли згадано техроботи; maintenance — лише коли пост тільки про даунтайм.
- sections: до 5 розділів, у кожному до 6 пунктів. Найважливіше для гравців — першим, дрібниці відкидай.
- Пункт — до 90 символів, один рядок без крапки в кінці. Якщо довше — скороти, а не обрізай.
- Числа й час (UTC) зберігай точно як в оригіналі. Нічого не вигадуй. Без markdown.`;

function digestMessage(item: SteamNewsItem, digest: NewsDigest): string {
  const sections = digest.sections.slice(0, 5).flatMap((section, i) => [
    ...(i > 0 ? [""] : []),
    `<b>${escapeHtml(truncate(`${section.emoji} ${section.title}`, 80))}</b>`,
    ...section.items.slice(0, 6).map((point) => `• ${escapeHtml(truncate(point, 200))}`),
  ]);

  const parts = [header(digest.kind, digest.title, item), "", escapeHtml(truncate(digest.summary, 700))];
  if (sections.length) parts.push("", collapsible(fit(sections, 2800)));
  parts.push("", footer(item));
  return parts.join("\n");
}

export async function newsMessage(item: SteamNewsItem): Promise<string> {
  if (!aiEnabled()) return plainMessage(item);
  try {
    const digest = await askJson<NewsDigest>(
      DIGEST_INSTRUCTIONS,
      `Заголовок: ${item.title}\n\n${truncate(bbcodeToText(item.contents), 30_000)}`,
      "news_digest",
      DIGEST_SCHEMA,
    );
    return digestMessage(item, digest);
  } catch (err) {
    console.error(`[news] GPT не смог пересказать ${item.gid}, шлю оригинал:`, err);
    return plainMessage(item);
  }
}
