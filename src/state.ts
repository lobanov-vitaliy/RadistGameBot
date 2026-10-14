import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export const TOPICS = ["gold", "news", "video"] as const;
export type Topic = (typeof TOPICS)[number];

export interface ChatConfig {
  id: number;
  title: string;
  topics: Record<Topic, boolean>;
}

export interface State {
  chats: ChatConfig[];
  goldPostedTs: number;
  newsSeeded: boolean;
  newsSeen: string[];
  videosSeen: string[];
}

const file = join(config.dataDir, "state.json");

export const allTopics = (): Record<Topic, boolean> => ({ gold: true, news: true, video: true });

const saved = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<State>) : {};

export const state: State = {
  goldPostedTs: 0,
  newsSeeded: false,
  newsSeen: [],
  videosSeen: [],
  ...saved,
  chats: (saved.chats ?? []).map((chat: ChatConfig | number) =>
    typeof chat === "number" ? { id: chat, title: "", topics: allTopics() } : chat,
  ),
};

export function saveState(): void {
  mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

export function remember(ids: string[], id: string, max: number): void {
  ids.push(id);
  if (ids.length > max) ids.splice(0, ids.length - max);
}
