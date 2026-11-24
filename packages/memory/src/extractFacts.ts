import {
  renderTranscript,
  type ChatMessage,
  type LlmClient,
} from "@burmalda/core";

const EXTRACT_PROMPT = `Ты извлекаешь из диалога устойчивые факты о владельце ассистента «бурмалда» для долговременной памяти.
Бери только то, что пригодится в будущих разговорах: предпочтения, привычки, люди и отношения, учёба и работа,
договорённости, планы с датами. Не бери разовые запросы, мнения ассистента и то, что уже есть в «Известно».
Каждый факт — короткое самодостаточное предложение от третьего лица («Владелец …»).
Ответь строго JSON-массивом строк без пояснений. Нет фактов — [].`;

/** Фоновое извлечение фактов после задачи (дешёвая модель). Возвращает новые факты. */
export async function extractFacts(options: {
  llm: LlmClient;
  model: string;
  messages: ChatMessage[];
  known?: string[];
  sessionId?: string;
}): Promise<string[]> {
  const transcript = renderTranscript(
    options.messages.filter((m) => m.role !== "system"),
    600,
  );
  if (!transcript.trim()) return [];
  const response = await options.llm.chat({
    model: options.model,
    messages: [
      { role: "system", content: EXTRACT_PROMPT },
      {
        role: "user",
        content: `Известно:\n${(options.known ?? []).map((f) => `- ${f}`).join("\n") || "—"}\n\nДиалог:\n${transcript}`,
      },
    ],
    user: options.sessionId,
    metadata: { tags: ["burmalda", "memory-extract"] },
  });
  return parseFactList(response.choices[0]?.message.content ?? "");
}

/** Устойчивый разбор: модель может обернуть JSON в ```json или добавить текст. */
export function parseFactList(raw: string): string[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 3 && item.length < 500)
      .slice(0, 10);
  } catch {
    return [];
  }
}
