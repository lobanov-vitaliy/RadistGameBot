import { config } from "./config.js";

interface ResponseOutput {
  type: string;
  content?: { type: string; text?: string }[];
}

export const aiEnabled = (): boolean => Boolean(config.openaiApiKey);

/** Один вызов OpenAI Responses API, возвращает склеенный output_text. */
async function respond(body: Record<string, unknown>): Promise<string> {
  if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY не задан");

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${config.openaiApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: config.openaiModel, ...body }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 500)}`);

  const data = (await res.json()) as { output?: ResponseOutput[] };
  const text = (data.output ?? [])
    .flatMap((item) => (item.type === "message" ? (item.content ?? []) : []))
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("OpenAI вернул пустой ответ");
  return text;
}

export function askText(instructions: string, input: string): Promise<string> {
  return respond({ instructions, input });
}

export async function askJson<T>(instructions: string, input: string, name: string, schema: object): Promise<T> {
  const text = await respond({
    instructions,
    input,
    text: { format: { type: "json_schema", name, schema, strict: true } },
  });
  return JSON.parse(text) as T;
}
