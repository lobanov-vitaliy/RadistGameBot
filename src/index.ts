import { setTimeout as sleep } from "node:timers/promises";
import { Cron } from "croner";
import { Bot, type Context, GrammyError, InputFile, type NextFunction } from "grammy";
import { config } from "./config.js";
import { type GoldReport, buildGoldReport, fetchGoldHistory, goldCaption, goldQuip, isTodaysRate } from "./gold.js";
import { renderGoldChart } from "./goldChart.js";
import { type SteamNewsItem, fetchSteamNews, firstImage, newsMessage } from "./news.js";
import { aiEnabled } from "./openai.js";
import { remember, saveState, state } from "./state.js";
import { type YouTubeVideo, nextVideos, shortsUrl, videoMessage, youtubeEnabled } from "./youtube.js";
import { DAY_MS, exclusive, htmlToPlain, truncate } from "./util.js";

const GOLD_RETRIES = 8;
const GOLD_RETRY_DELAY_MS = 15 * 60_000;
/** Посты старше этого не публикуем — чтобы не вывалить в новую группу старьё. */
const MAX_NEWS_AGE_MS = 3 * DAY_MS;

const bot = new Bot(config.botToken);

// ---------- Куда постим ----------
// Бот сам запоминает группы и каналы, куда его добавили, и забывает, когда удаляют.

function addChat(chatId: number): boolean {
  if (state.chats.includes(chatId)) return false;
  state.chats.push(chatId);
  saveState();
  return true;
}

function removeChat(chatId: number): void {
  state.chats = state.chats.filter((id) => id !== chatId);
  saveState();
}

const hasChats = (): boolean => state.chats.length > 0;

/** Отправляет во все чаты. Бросает ошибку, только если не доставлено никуда. */
async function broadcast(send: (chatId: number) => Promise<unknown>): Promise<void> {
  if (!hasChats()) throw new Error("Бота ще не додано в жодну групу");
  let lastError: unknown;
  let delivered = 0;
  for (const chatId of [...state.chats]) {
    try {
      await send(chatId);
      delivered++;
    } catch (err) {
      lastError = err;
      if (err instanceof GrammyError && err.error_code === 403) {
        console.warn(`[chats] бота убрали из ${chatId}, забываю`);
        removeChat(chatId);
      } else {
        console.error(`[chats] не удалось отправить в ${chatId}:`, err);
      }
    }
  }
  if (!delivered) throw lastError;
}

// ---------- Голда ----------

interface GoldPost {
  photo: Buffer;
  caption: string;
}

async function buildGoldPost(report: GoldReport): Promise<GoldPost> {
  const quip = aiEnabled()
    ? await goldQuip(report).catch((err) => {
        console.error("[gold] GPT не придумал шутку:", err);
        return undefined;
      })
    : undefined;
  return { photo: renderGoldChart(report), caption: goldCaption(report, quip && truncate(quip, 200)) };
}

const sendGold = (chatId: number, post: GoldPost) =>
  bot.api.sendPhoto(chatId, new InputFile(post.photo, "gold.png"), { caption: post.caption, parse_mode: "HTML" });

type GoldResult = "posted" | "already" | "stale";

const publishGold = exclusive(async (): Promise<GoldResult> => {
  const report = buildGoldReport(await fetchGoldHistory());
  if (!isTodaysRate(report)) return "stale";
  if (report.latest.ts <= state.goldPostedTs) return "already";
  const post = await buildGoldPost(report);
  await broadcast((chatId) => sendGold(chatId, post));
  state.goldPostedTs = report.latest.ts;
  saveState();
  return "posted";
});

/** Курс меняется в 00:00 UTC, но сайт может обновиться с опозданием — тогда пробуем ещё. */
async function goldWithRetries(): Promise<void> {
  for (let attempt = 1; attempt <= GOLD_RETRIES; attempt++) {
    try {
      const result = await publishGold();
      if (result !== "stale") {
        console.log(`[gold] ${result}`);
        return;
      }
      console.log(`[gold] курса за сегодня ещё нет, попытка ${attempt}/${GOLD_RETRIES}`);
    } catch (err) {
      console.error(`[gold] попытка ${attempt}/${GOLD_RETRIES}:`, err);
    }
    if (attempt < GOLD_RETRIES) await sleep(GOLD_RETRY_DELAY_MS);
  }
}

// ---------- Новости ----------

async function sendNews(chatId: number, item: SteamNewsItem, text: string): Promise<void> {
  const image = firstImage(item);
  const link_preview_options = image
    ? { url: image, prefer_large_media: true, show_above_text: true }
    : { is_disabled: true };
  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options });
  } catch (err) {
    // Если Telegram не разобрал разметку — лучше без форматирования, чем без новости
    if (!(err instanceof GrammyError && err.description.includes("can't parse entities"))) throw err;
    console.error(`[news] Telegram не принял разметку ${item.gid}:`, err.description);
    await bot.api.sendMessage(chatId, htmlToPlain(text), { link_preview_options });
  }
}

const publishNews = exclusive(async (): Promise<number> => {
  const items = await fetchSteamNews();
  if (!state.newsSeeded) {
    for (const item of items) remember(state.newsSeen, item.gid, 500);
    state.newsSeeded = true;
    saveState();
    console.log(`[news] первый запуск: ${items.length} старых постов помечены как прочитанные`);
    return 0;
  }

  const seen = new Set(state.newsSeen);
  const fresh = items.filter((item) => !seen.has(item.gid)).sort((a, b) => a.date - b.date);
  let posted = 0;
  for (const item of fresh) {
    if (Date.now() - item.date * 1000 <= MAX_NEWS_AGE_MS) {
      const text = await newsMessage(item);
      await broadcast((chatId) => sendNews(chatId, item, text));
      posted++;
    }
    remember(state.newsSeen, item.gid, 500);
    saveState();
  }
  return posted;
});

// ---------- Видео ----------

const publishVideo = exclusive(async (): Promise<YouTubeVideo | undefined> => {
  if (!hasChats()) throw new Error("Бота ще не додано в жодну групу");
  const [video] = await nextVideos(new Set(state.videosSeen));
  if (!video) return undefined;
  const { text, previewUrl } = videoMessage(video);
  await broadcast((chatId) =>
    bot.api.sendMessage(chatId, text, {
      parse_mode: "HTML",
      link_preview_options: { url: previewUrl, prefer_large_media: true, show_above_text: true },
    }),
  );
  remember(state.videosSeen, video.id, 5000);
  saveState();
  console.log(`[video] отправлено ${shortsUrl(video)}`);
  return video;
});

// ---------- Группы ----------

const HELP = [
  "Я надсилаю в групу все про WARDOGS:",
  "🪙 курс золота — щодня о 00:15 UTC, картинкою за 10 днів",
  "📰 новини, патчі та хотфікси — перевіряю щогодини",
  ...(youtubeEnabled() ? ["🎬 популярні Shorts з YouTube — кожні 15 хвилин"] : []),
  "",
  "Команди для адмінів групи:",
  "/gold — опублікувати курс, якщо сьогодні ще не було",
  "/news — перевірити новини просто зараз",
  ...(youtubeEnabled() ? ["/video — наступне популярне відео"] : []),
  "/preview — картинка курсу й остання новина сюди, в цей чат",
].join("\n");

bot.on("my_chat_member", async (ctx) => {
  const { chat, new_chat_member: member } = ctx.myChatMember;
  if (chat.type === "private") return;

  const inChat =
    member.status === "member" ||
    member.status === "administrator" ||
    (member.status === "restricted" && member.is_member);
  if (!inChat) {
    removeChat(chat.id);
    console.log(`[chats] удалён из «${chat.title}» (${chat.id})`);
    return;
  }
  // Повторное событие, например боту дали админку
  if (!addChat(chat.id)) return;

  console.log(`[chats] добавлен в «${chat.title}» (${chat.id})`);
});

// Группа стала супергруппой — у неё сменился id
bot.on("message:migrate_to_chat_id", (ctx) => {
  if (!state.chats.includes(ctx.chat.id)) return;
  removeChat(ctx.chat.id);
  addChat(ctx.msg.migrate_to_chat_id);
});

// ---------- Команды ----------

async function isChatAdmin(chatId: number, userId: number): Promise<boolean> {
  const member = await bot.api.getChatMember(chatId, userId).catch(() => undefined);
  return member?.status === "creator" || member?.status === "administrator";
}

/** Командами пользуются админы группы. В личке с ботом — админ любой из его групп. */
async function adminOnly(ctx: Context, next: NextFunction): Promise<void> {
  const chat = ctx.chat;
  const userId = ctx.from?.id;
  if (!chat || !userId) return;

  // Анонимный админ пишет от имени самой группы
  let allowed = ctx.senderChat?.id === chat.id;
  for (const chatId of chat.type === "private" ? state.chats : [chat.id]) {
    if (allowed) break;
    allowed = await isChatAdmin(chatId, userId);
  }
  if (!allowed) {
    await ctx.reply("Ця команда лише для адмінів групи");
    return;
  }
  // Подстраховка, если событие о добавлении в группу потерялось
  if (chat.type !== "private" && addChat(chat.id)) console.log(`[chats] добавлен в «${chat.title}» (${chat.id})`);
  await next();
}

/** Подтверждение нужно только в личке: в группе результат и так виден. */
async function ack(ctx: Context, text: string): Promise<void> {
  if (ctx.chat?.type === "private") await ctx.reply(text);
}

bot.command(["start", "help"], (ctx) => ctx.reply(HELP));

bot.command("gold", adminOnly, async (ctx) => {
  const result = await publishGold();
  if (result === "posted") await ack(ctx, "Курс опубліковано ✅");
  if (result === "already") await ctx.reply("Курс за сьогодні вже був");
  if (result === "stale") await ctx.reply("Курс за сьогодні ще не оновився, надішлю, щойно з'явиться");
});

bot.command("news", adminOnly, async (ctx) => {
  const count = await publishNews();
  if (count) await ack(ctx, `Опубліковано новин: ${count} ✅`);
  else await ctx.reply("Нових постів у Steam немає");
});

bot.command("video", adminOnly, async (ctx) => {
  if (!youtubeEnabled()) return ctx.reply("Відео вимкнено: вкажи YOUTUBE_API_KEY у .env");
  const video = await publishVideo();
  if (video) await ack(ctx, `Відео опубліковано ✅\n${shortsUrl(video)}`);
  else await ctx.reply("Нових відео не знайшлося");
});

bot.command("preview", adminOnly, async (ctx) => {
  await sendGold(ctx.chat.id, await buildGoldPost(buildGoldReport(await fetchGoldHistory())));
  const [latest] = await fetchSteamNews(1);
  if (latest) await sendNews(ctx.chat.id, latest, await newsMessage(latest));
});

bot.catch(async (err) => {
  console.error("[bot]", err.error);
  // Подробности только в логе, чтобы в чат не утекали внутренние детали
  await err.ctx.reply("Щось пішло не так, спробуй ще раз пізніше").catch(() => {});
});

// ---------- Запуск ----------

/** Для расписания: пока бот ни в одной группе, ничего не делаем. */
async function scheduled(name: string, job: () => Promise<unknown>): Promise<void> {
  if (!hasChats()) return;
  try {
    const result = await job();
    if (result !== undefined) console.log(`[${name}] ${result}`);
  } catch (err) {
    console.error(`[${name}]`, err);
  }
}

const runNews = () => scheduled("news", async () => `новых постов: ${await publishNews()}`);

const jobs = [
  new Cron(config.goldCron, { timezone: "UTC", name: "gold" }, () => scheduled("gold", goldWithRetries)),
  new Cron(config.newsCron, { timezone: "UTC", name: "news" }, runNews),
];
if (youtubeEnabled()) {
  jobs.push(
    new Cron(config.videoCron, { timezone: "UTC", name: "video" }, () =>
      scheduled("video", async () => void (await publishVideo())),
    ),
  );
}

if (!aiEnabled()) console.warn("OPENAI_API_KEY не задан: новости пойдут без пересказа, курс без шутки");
if (!youtubeEnabled()) console.warn("YOUTUBE_API_KEY не задан: видео с YouTube выключены");

// Догоняем пропущенное, если бот перезапускался
void scheduled("gold", publishGold);
void runNews();
// Запоминаем текущие посты Steam сразу, чтобы в новую группу не прилетели старые
if (!state.newsSeeded) void publishNews().catch((err) => console.error("[news]", err));

const stop = (): void => {
  for (const job of jobs) job.stop();
  void bot.stop();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

// Меню команд видят только админы групп
await bot.api.setMyCommands(
  [
    { command: "gold", description: "Опублікувати курс золота" },
    { command: "news", description: "Перевірити новини WARDOGS" },
    ...(youtubeEnabled() ? [{ command: "video", description: "Наступне відео з YouTube" }] : []),
    { command: "preview", description: "Курс і остання новина в цей чат" },
  ],
  { scope: { type: "all_chat_administrators" } },
);

await bot.start({
  onStart: (me) => {
    console.log(`@${me.username} запущен, групп: ${state.chats.length}`);
    if (!hasChats()) console.log(`  добавь бота в группу: https://t.me/${me.username}?startgroup=true`);
    for (const job of jobs) console.log(`  ${job.name}: следующий запуск ${job.nextRun()?.toISOString()}`);
  },
});
