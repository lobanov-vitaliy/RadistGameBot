import { config } from "./config.js";
import { escapeHtml, formatCompact, truncate } from "./util.js";

const API = "https://www.googleapis.com/youtube/v3";
/** Shorts бывают до 3 минут */
const MAX_DURATION_SEC = 180;
/** Поиск стоит 100 единиц из 10 000 бесплатных в сутки, поэтому кандидатов обновляем раз в 3 часа. */
const CANDIDATES_TTL_MS = 3 * 60 * 60_000;
/** Отсекаем клипы из фильма «War Dogs» (2016) и прочий шум: игра пишется слитно. */
const PUBLISHED_AFTER = "2025-01-01T00:00:00Z";
const ABOUT_GAME = /wardogs/i;

export interface YouTubeVideo {
  id: string;
  title: string;
  channel: string;
  durationSec: number;
  views: number;
  likes?: number;
}

interface RawVideo {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    channelTitle?: string;
    tags?: string[];
    liveBroadcastContent?: string;
  };
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string; likeCount?: string };
}

export const youtubeEnabled = (): boolean => Boolean(config.youtubeApiKey);

async function api<T>(method: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${API}/${method}`);
  url.search = new URLSearchParams({ ...params, key: config.youtubeApiKey ?? "" }).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`YouTube API ${method} ответил ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

async function searchIds(keyword: string): Promise<string[]> {
  const json = await api<{ items?: { id?: { videoId?: string } }[] }>("search", {
    part: "id",
    q: keyword,
    type: "video",
    videoDuration: "short",
    order: "viewCount",
    publishedAfter: PUBLISHED_AFTER,
    maxResults: "50",
  });
  return (json.items ?? []).flatMap((item) => (item.id?.videoId ? [item.id.videoId] : []));
}

/** ISO 8601: PT1M5S → 65 */
function parseDuration(iso = ""): number {
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}

/** Поиск отдаёт только id; названия, длительность и просмотры берём отдельным запросом (1 единица на 50 видео). */
async function videoDetails(ids: string[]): Promise<YouTubeVideo[]> {
  const videos: YouTubeVideo[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const json = await api<{ items?: RawVideo[] }>("videos", {
      part: "snippet,contentDetails,statistics",
      id: ids.slice(i, i + 50).join(","),
    });
    for (const v of json.items ?? []) {
      const s = v.snippet ?? {};
      const durationSec = parseDuration(v.contentDetails?.duration);
      const aboutGame = ABOUT_GAME.test([s.title, s.description, ...(s.tags ?? [])].join(" "));
      if (!aboutGame || s.liveBroadcastContent !== "none" || durationSec === 0) continue;
      videos.push({
        id: v.id,
        title: s.title?.trim() ?? "",
        channel: s.channelTitle?.trim() ?? "",
        durationSec,
        views: Number(v.statistics?.viewCount ?? 0),
        likes: v.statistics?.likeCount === undefined ? undefined : Number(v.statistics.likeCount),
      });
    }
  }
  return videos;
}

let cache: { at: number; videos: YouTubeVideo[] } | undefined;

/** Ещё не отправленные Shorts по ключевым словам, самые просматриваемые первыми. */
export async function nextVideos(seen: Set<string>): Promise<YouTubeVideo[]> {
  if (!cache || Date.now() - cache.at > CANDIDATES_TTL_MS) {
    const ids = new Set<string>();
    for (const keyword of config.youtubeKeywords) {
      for (const id of await searchIds(keyword)) ids.add(id);
    }
    const videos = await videoDetails([...ids]);
    cache = { at: Date.now(), videos: videos.sort((a, b) => b.views - a.views) };
  }
  return cache.videos.filter((v) => !seen.has(v.id) && v.durationSec <= MAX_DURATION_SEC);
}

export const shortsUrl = (video: YouTubeVideo): string => `https://youtube.com/shorts/${video.id}`;

/** Текст поста и ссылка для превью: по обычной ссылке на видео Telegram показывает плеер. */
export function videoMessage(video: YouTubeVideo): { text: string; previewUrl: string } {
  const stats = [`👁 ${formatCompact(video.views)}`];
  if (video.likes !== undefined) stats.push(`❤️ ${formatCompact(video.likes)}`);
  if (video.channel) stats.push(escapeHtml(video.channel));

  const text = [
    `🎬 <b>${escapeHtml(truncate(video.title, 200))}</b>`,
    "",
    stats.join(" · "),
    `▶️ <a href="${shortsUrl(video)}">Дивитись на YouTube</a>`,
  ].join("\n");
  return { text, previewUrl: `https://www.youtube.com/watch?v=${video.id}` };
}
