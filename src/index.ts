import { setTimeout as sleep } from "node:timers/promises";
import { autoRetry } from "@grammyjs/auto-retry";
import { Cron } from "croner";
import { Bot, type Context, GrammyError, InlineKeyboard, InputFile, type NextFunction } from "grammy";
import { config } from "./config.js";
import { type GoldReport, buildGoldReport, fetchGoldHistory, goldCaption, goldQuip, isTodaysRate } from "./gold.js";
import { renderGoldChart } from "./goldChart.js";
import { type SteamNewsItem, fetchSteamNews, firstImage, newsMessage } from "./news.js";
import { aiEnabled } from "./openai.js";
import { type ChatConfig, TOPICS, type Topic, allTopics, remember, saveState, state } from "./state.js";
import { type YouTubeVideo, nextVideos, shortsUrl, translateTitle, videoMessage, youtubeEnabled } from "./youtube.js";
import { DAY_MS, exclusive, htmlToPlain, truncate } from "./util.js";

const GOLD_RETRIES = 8;
const GOLD_RETRY_DELAY_MS = 15 * 60_000;
const MAX_NEWS_AGE_MS = 3 * DAY_MS;

const bot = new Bot(config.botToken);
bot.api.config.use(autoRetry({ maxRetryAttempts: 5, maxDelaySeconds: 60 }));

const findChat = (chatId: number): ChatConfig | undefined => state.chats.find((chat) => chat.id === chatId);

function addChat(chatId: number, title: string): boolean {
  const existing = findChat(chatId);
  if (existing) {
    if (title && existing.title !== title) {
      existing.title = title;
      saveState();
    }
    return false;
  }
  state.chats.push({ id: chatId, title, topics: allTopics() });
  saveState();
  return true;
}

function removeChat(chatId: number): void {
  state.chats = state.chats.filter((chat) => chat.id !== chatId);
  saveState();
}

const subscribers = (topic: Topic): number[] =>
  state.chats.filter((chat) => chat.topics[topic]).map((chat) => chat.id);

async function broadcast(topic: Topic, send: (chatId: number) => Promise<unknown>): Promise<void> {
  let lastError: unknown = new Error(`Жоден чат не підписаний на ${topic}`);
  let delivered = 0;
  for (const chatId of subscribers(topic)) {
    try {
      await send(chatId);
      delivered++;
    } catch (err) {
      lastError = err;
      if (err instanceof GrammyError && err.error_code === 403) {
        console.warn(`[chats] бота убрали из ${chatId}, забываю`);
        removeChat(chatId);
      } else {
        console.error(`[chats] не удалось отправить в ${chatId}:`, err instanceof GrammyError ? err.description : err);
      }
    }
  }
  if (!delivered) throw lastError;
}

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

type GoldResult = "posted" | "already" | "stale" | "nobody";

const publishGold = exclusive(async (): Promise<GoldResult> => {
  if (!subscribers("gold").length) return "nobody";
  const report = buildGoldReport(await fetchGoldHistory());
  if (!isTodaysRate(report)) return "stale";
  if (report.latest.ts <= state.goldPostedTs) return "already";
  const post = await buildGoldPost(report);
  await broadcast("gold", (chatId) => sendGold(chatId, post));
  state.goldPostedTs = report.latest.ts;
  saveState();
  return "posted";
});

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

async function sendNews(chatId: number, item: SteamNewsItem, text: string): Promise<void> {
  const image = firstImage(item);
  const link_preview_options = image
    ? { url: image, prefer_large_media: true, show_above_text: true }
    : { is_disabled: true };
  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options });
  } catch (err) {
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
  if (!subscribers("news").length) return 0;

  const seen = new Set(state.newsSeen);
  const fresh = items.filter((item) => !seen.has(item.gid)).sort((a, b) => a.date - b.date);
  let posted = 0;
  for (const item of fresh) {
    if (Date.now() - item.date * 1000 <= MAX_NEWS_AGE_MS) {
      const text = await newsMessage(item);
      await broadcast("news", (chatId) => sendNews(chatId, item, text));
      posted++;
    }
    remember(state.newsSeen, item.gid, 500);
    saveState();
  }
  return posted;
});

const publishVideo = exclusive(async (): Promise<YouTubeVideo | undefined> => {
  if (!subscribers("video").length) return undefined;
  const [video] = await nextVideos(new Set(state.videosSeen));
  if (!video) return undefined;
  const translated = await translateTitle(video).catch((err) => {
    console.error("[video] GPT не перевёл название:", err);
    return undefined;
  });
  const { text, previewUrl } = videoMessage(video, translated);
  await broadcast("video", (chatId) =>
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

bot.on("my_chat_member", (ctx) => {
  const { chat, new_chat_member: member } = ctx.myChatMember;
  if (chat.type === "private") return;

  const inChat =
    member.status === "member" ||
    member.status === "administrator" ||
    (member.status === "restricted" && member.is_member);
  if (!inChat) {
    removeChat(chat.id);
    console.log(`[chats] удалён из «${chat.title}» (${chat.id})`);
  } else if (addChat(chat.id, chat.title)) {
    console.log(`[chats] добавлен в «${chat.title}» (${chat.id})`);
  }
});

bot.on("message:migrate_to_chat_id", (ctx) => {
  const chat = findChat(ctx.chat.id);
  if (!chat) return;
  chat.id = ctx.msg.migrate_to_chat_id;
  saveState();
});

async function isChatAdmin(chatId: number, userId: number): Promise<boolean> {
  const member = await bot.api.getChatMember(chatId, userId).catch(() => undefined);
  return member?.status === "creator" || member?.status === "administrator";
}

async function isAdmin(ctx: Context): Promise<boolean> {
  const chat = ctx.chat;
  const userId = ctx.from?.id;
  if (!chat || !userId) return false;
  if (ctx.senderChat?.id === chat.id) return true;
  for (const chatId of chat.type === "private" ? state.chats.map((c) => c.id) : [chat.id]) {
    if (await isChatAdmin(chatId, userId)) return true;
  }
  return false;
}

async function adminOnly(ctx: Context, next: NextFunction): Promise<void> {
  if (!(await isAdmin(ctx))) return;
  const chat = ctx.chat;
  if (chat && chat.type !== "private" && addChat(chat.id, chat.title)) {
    console.log(`[chats] добавлен в «${chat.title}» (${chat.id})`);
  }
  await next();
}

async function adminChats(userId: number): Promise<ChatConfig[]> {
  const result: ChatConfig[] = [];
  for (const chat of state.chats) {
    if (!(await isChatAdmin(chat.id, userId))) continue;
    if (!chat.title) {
      const info = await bot.api.getChat(chat.id).catch(() => undefined);
      if (info && "title" in info && info.title) addChat(chat.id, info.title);
    }
    result.push(chat);
  }
  return result;
}

const TOPIC_LABEL: Record<Topic, string> = {
  gold: "🪙 Курс золота",
  news: "📰 Новини",
  video: "🎬 Відео з YouTube",
};

const availableTopics = (): Topic[] => TOPICS.filter((topic) => topic !== "video" || youtubeEnabled());

const settingsText = (chat: ChatConfig): string =>
  `⚙️ Що надсилати в «${chat.title || "цей чат"}»\nНатисни, щоб увімкнути або вимкнути.`;

function settingsKeyboard(chat: ChatConfig, withBack: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const topic of availableTopics()) {
    keyboard.text(`${chat.topics[topic] ? "✅" : "❌"} ${TOPIC_LABEL[topic]}`, `topic:${chat.id}:${topic}`).row();
  }
  if (withBack) keyboard.text("← Усі чати", "chats");
  return keyboard;
}

const NO_CHATS = "Ти не адмін жодної групи чи каналу, де є бот.";

function chatsKeyboard(chats: ChatConfig[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const chat of chats) keyboard.text(`⚙️ ${chat.title || chat.id}`, `chat:${chat.id}`).row();
  return keyboard;
}

bot.command("settings", adminOnly, async (ctx) => {
  if (ctx.chat.type !== "private") {
    const chat = findChat(ctx.chat.id)!;
    await ctx.reply(settingsText(chat), { reply_markup: settingsKeyboard(chat, false) });
    return;
  }
  const chats = await adminChats(ctx.from!.id);
  await ctx.reply(chats.length ? "Обери чат:" : NO_CHATS, { reply_markup: chatsKeyboard(chats) });
});

bot.callbackQuery("chats", async (ctx) => {
  const chats = await adminChats(ctx.from.id);
  await ctx.editMessageText(chats.length ? "Обери чат:" : NO_CHATS, { reply_markup: chatsKeyboard(chats) });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^chat:(-?\d+)$/, async (ctx) => {
  const chat = findChat(Number(ctx.match[1]));
  if (!chat || !(await isChatAdmin(chat.id, ctx.from.id))) {
    await ctx.answerCallbackQuery({ text: "Немає доступу" });
    return;
  }
  await ctx.editMessageText(settingsText(chat), { reply_markup: settingsKeyboard(chat, true) });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^topic:(-?\d+):(\w+)$/, async (ctx) => {
  const chat = findChat(Number(ctx.match[1]));
  const topic = ctx.match[2] as Topic;
  if (!chat || !TOPICS.includes(topic) || !(await isChatAdmin(chat.id, ctx.from.id))) {
    await ctx.answerCallbackQuery({ text: "Лише для адмінів" });
    return;
  }
  chat.topics[topic] = !chat.topics[topic];
  saveState();
  await ctx.editMessageReplyMarkup({ reply_markup: settingsKeyboard(chat, ctx.chat?.type === "private") });
  await ctx.answerCallbackQuery({ text: `${TOPIC_LABEL[topic]}: ${chat.topics[topic] ? "увімкнено" : "вимкнено"}` });
});

const HELP = [
  "Я надсилаю в групи й канали все про WARDOGS:",
  "🪙 курс золота — щодня о 00:15 UTC, картинкою за 10 днів",
  "📰 новини, патчі та хотфікси — перевіряю щогодини",
  ...(youtubeEnabled() ? ["🎬 популярні Shorts з YouTube — щогодини"] : []),
  "",
  "Команди бачать і можуть використовувати лише адміни:",
  "/settings — що надсилати в цей чат (в особистих — у будь-який твій чат чи канал)",
  "/gold — опублікувати курс, якщо сьогодні ще не було",
  "/news — перевірити новини просто зараз",
  ...(youtubeEnabled() ? ["/video — наступне популярне відео"] : []),
  "/preview — картинка курсу й остання новина сюди",
].join("\n");

const INTRO = "Я надсилаю курс золота, новини та відео про WARDOGS. Додай мене в групу або канал.";

bot.command(["start", "help"], async (ctx) => {
  if (await isAdmin(ctx)) await ctx.reply(HELP);
  else if (ctx.chat.type === "private") await ctx.reply(INTRO);
});

async function ack(ctx: Context, text: string): Promise<void> {
  if (ctx.chat?.type === "private") await ctx.reply(text);
}

const disabledEverywhere = (topic: Topic): string => `${TOPIC_LABEL[topic]}: вимкнено в усіх чатах, див. /settings`;

bot.command("gold", adminOnly, async (ctx) => {
  const result = await publishGold();
  if (result === "posted") await ack(ctx, "Курс опубліковано ✅");
  if (result === "already") await ctx.reply("Курс за сьогодні вже був");
  if (result === "stale") await ctx.reply("Курс за сьогодні ще не оновився, надішлю, щойно з'явиться");
  if (result === "nobody") await ctx.reply(disabledEverywhere("gold"));
});

bot.command("news", adminOnly, async (ctx) => {
  if (!subscribers("news").length) return ctx.reply(disabledEverywhere("news"));
  const count = await publishNews();
  if (count) await ack(ctx, `Опубліковано новин: ${count} ✅`);
  else await ctx.reply("Нових постів у Steam немає");
});

bot.command("video", adminOnly, async (ctx) => {
  if (!youtubeEnabled()) return ctx.reply("Відео вимкнено: вкажи YOUTUBE_API_KEY у .env");
  if (!subscribers("video").length) return ctx.reply(disabledEverywhere("video"));
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
  await err.ctx.reply("Щось пішло не так, спробуй ще раз пізніше").catch(() => {});
});

async function logged(name: string, job: () => Promise<unknown>): Promise<void> {
  try {
    const result = await job();
    if (result !== undefined) console.log(`[${name}] ${result}`);
  } catch (err) {
    console.error(`[${name}]`, err);
  }
}

const runNews = () => logged("news", async () => `новых постов: ${await publishNews()}`);

const jobs = [
  new Cron(config.goldCron, { timezone: "UTC", name: "gold" }, goldWithRetries),
  new Cron(config.newsCron, { timezone: "UTC", name: "news" }, runNews),
];
if (youtubeEnabled()) {
  jobs.push(
    new Cron(config.videoCron, { timezone: "UTC", name: "video" }, () =>
      logged("video", async () => void (await publishVideo())),
    ),
  );
}

if (!aiEnabled()) console.warn("OPENAI_API_KEY не задан: новости пойдут без пересказа, курс без шутки");
if (!youtubeEnabled()) console.warn("YOUTUBE_API_KEY не задан: видео с YouTube выключены");

void logged("gold", publishGold);
void runNews();

const stop = (): void => {
  for (const job of jobs) job.stop();
  void bot.stop();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

await Promise.all([
  bot.api.deleteMyCommands(),
  bot.api.deleteMyCommands({ scope: { type: "all_chat_administrators" } }),
]).catch((err) => console.error("[bot] не удалось убрать меню команд:", err));

await bot.start({
  onStart: (me) => {
    console.log(`@${me.username} запущен, чатов: ${state.chats.length}`);
    if (!state.chats.length) console.log(`  добавь бота в группу: https://t.me/${me.username}?startgroup=true`);
    for (const job of jobs) console.log(`  ${job.name}: следующий запуск ${job.nextRun()?.toISOString()}`);
  },
});
