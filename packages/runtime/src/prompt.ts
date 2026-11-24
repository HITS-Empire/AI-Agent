import { PROJECT_NAME } from "@burmalda/shared";

export interface PromptParts {
  now: Date;
  timeZone?: string;
  profile?: Record<string, string>;
  facts?: string[];
  agentsMd?: Array<{ path: string; content: string }>;
  skills?: Array<{ name: string; description: string; path: string }>;
  toolNames?: string[];
  channel?: string;
}

/**
 * System prompt собирается заново на каждую задачу и в БД не пишется:
 * роль → дата и часовой пояс → профиль → вспомненные факты → AGENTS.md → список скиллов.
 */
export function buildSystemPrompt(parts: PromptParts): string {
  const timeZone = parts.timeZone ?? "Asia/Tomsk";
  const date = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(parts.now);

  const sections: string[] = [
    `Ты — «${PROJECT_NAME}», персональный ИИ-ассистент одного владельца. Отвечай по-русски, коротко и по делу.
Сначала думай, нужен ли инструмент; если нужен — вызывай, не выдумывай результаты. Не знаешь — скажи.
Сейчас ${date} (${timeZone}). Все даты и время владельцу — в этом часовом поясе.
Канал: ${parts.channel ?? "cli"}. Сессия общая для всех каналов: разговор мог начаться в другом интерфейсе.
Устойчивые факты о владельце сохраняй инструментом remember, вспоминай — recall_memory.
Опасные действия (запись вне workspace, команды на хосте) требуют подтверждения владельца — инструмент сам его спросит.`,
  ];

  const profile = Object.entries(parts.profile ?? {});
  if (profile.length > 0) {
    sections.push(
      `## Профиль владельца\n${profile.map(([k, v]) => `- ${k}: ${v}`).join("\n")}`,
    );
  }
  if (parts.facts?.length) {
    sections.push(
      `## Вспомнилось из долговременной памяти (может быть неактуально)\n${parts.facts.map((f) => `- ${f}`).join("\n")}`,
    );
  }
  for (const file of parts.agentsMd ?? []) {
    sections.push(`## Инструкции из ${file.path}\n${file.content.trim()}`);
  }
  if (parts.skills?.length) {
    sections.push(
      `## Навыки\nПеред задачей из этой области загрузи навык инструментом load_skill и следуй ему.\n${parts.skills
        .map((s) => `- ${s.name}: ${s.description}`)
        .join("\n")}`,
    );
  }
  return sections.join("\n\n");
}
