import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export interface State {
  /** группы и каналы, куда добавлен бот — туда и постим */
  chats: number[];
  /** ts (полночь UTC) последнего опубликованного курса голды */
  goldPostedTs: number;
  /** при первом запуске старые новости помечаются прочитанными, а не постятся */
  newsSeeded: boolean;
  /** gid опубликованных постов Steam */
  newsSeen: string[];
  /** id уже отправленных видео YouTube */
  videosSeen: string[];
}

const file = join(config.dataDir, "state.json");

export const state: State = {
  chats: [],
  goldPostedTs: 0,
  newsSeeded: false,
  newsSeen: [],
  videosSeen: [],
  ...(existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<State>) : {}),
};

export function saveState(): void {
  mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

/** Добавляет id в список и обрезает самые старые, чтобы файл не рос бесконечно. */
export function remember(ids: string[], id: string, max: number): void {
  ids.push(id);
  if (ids.length > max) ids.splice(0, ids.length - max);
}
