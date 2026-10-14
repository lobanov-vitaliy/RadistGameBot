try {
  process.loadEnvFile();
} catch {}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Не задана переменная окружения ${name} (см. .env.example)`);
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  botToken: required("BOT_TOKEN"),

  openaiApiKey: optional("OPENAI_API_KEY"),
  openaiModel: optional("OPENAI_MODEL") ?? "gpt-6-luna",
  openaiReasoningEffort: optional("OPENAI_REASONING_EFFORT") ?? "none",

  youtubeApiKey: optional("YOUTUBE_API_KEY"),
  youtubeKeywords: list(optional("YOUTUBE_KEYWORDS") ?? "wardogs funny,wardogs moments,wardogs"),

  goldCron: optional("GOLD_CRON") ?? "15 0 * * *",
  newsCron: optional("NEWS_CRON") ?? "0 * * * *",
  videoCron: optional("VIDEO_CRON") ?? "30 * * * *",

  dataDir: optional("DATA_DIR") ?? "data",
};
