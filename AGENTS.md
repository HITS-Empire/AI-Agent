# AGENTS.md — правила разработки «бурмалды»

Учебный проект: персональный ИИ-ассистент «бурмалда» (лаба Т-Банк Образование, модуль 1).
Задание — `docs/ASSIGNMENT.md`, план и распределение работ — `docs/PLAN.md`. Эти два файла — источник правды.

## Жёсткие условия лабы

- `packages/core` — ядро агента **без библиотек**: только `node:*`, свои модули и `@burmalda/shared`.
  Никаких openai/anthropic SDK, LangChain, Vercel AI SDK, `@modelcontextprotocol/sdk` и т. п. Это проверяет ESLint (`no-restricted-imports`).
  Цикл агента, tool calling, MCP-клиент (JSON-RPC 2.0 по stdio и Streamable HTTP), compaction, AGENTS.md/SKILL.md — пишем сами.
- Open-source агентов (Codex, OpenHands, OpenClaw, Aider, …) можно читать для вдохновения, копировать код нельзя.
- Все вызовы моделей (чат и эмбеддинги) — только через LiteLLM (`GatewayClient`, алиасы `burmalda-*`). Прямой запрос к провайдеру — нарушение задания.
- Все shell-команды и код агента по умолчанию выполняются в Docker-песочнице. Host-shell — только по явному подтверждению владельца.
- Название «бурмалда» должно быть на видном месте в каждом интерфейсе (`PROJECT_NAME`, `BANNER` из `@burmalda/shared`).

## Стек и структура

- TypeScript 5.9, Node 22, pnpm 10 (workspaces), ESM, запуск через `tsx`.
- `packages/shared` — конфиг, логгер (pino, JSON), общие типы (`AgentTask`, `AgentEvent`). Меняем контракты только вдвоём.
- `packages/core` — цикл агента, LLM-клиент, реестр инструментов, compaction, AGENTS.md, SKILL.md, MCP.
- `packages/memory` — Postgres + pgvector: сессии, саммари, факты.
- `packages/sandbox` — песочница (docker) и host-shell (pwsh 7 / bash / zsh).
- `packages/queue` — общая очередь задач (BullMQ/Redis) и события в интерфейсы.
- `packages/integrations` — интеграции без LLM: календари (Radicale/CalDAV, TSU.InTime, iCal), маркетплейсы, поиск.
- `skills/<name>/SKILL.md` — встроенные навыки агента (стандарт SKILL.md).
- `apps/worker` — единственный процесс с циклом агента и планировщиком; `apps/cli`, `apps/telegram` — тонкие интерфейсы.
- `infra/` — конфиги LiteLLM, Postgres, образ песочницы. Инфраструктура — `docker-compose.yml`.

## Как работать

- Код без модели тестируем на `FakeLlmClient` или `burmalda-mock`, токены тратим только там, где без живой модели не проверить.
- Перед коммитом: `pnpm check` (typecheck + lint + prettier). CI гоняет то же на Linux, macOS и Windows.
- Стиль как в Sonella: двойные кавычки, trailing commas, JSDoc-комментарии по-русски там, где неочевидно «зачем».
- Незаконченное помечаем `notImplemented("…")` или `TODO(A|B): …` с владельцем. Поиск по ним = список оставшихся задач.
- Ветки `feat/<кратко>`, MR/PR в `main`, ревью вторым участником. Conventional commits (`feat:`, `fix:`, `docs:`).
- Секреты только в `.env` и `.secrets/` (оба в .gitignore). Не логировать ключи и токены, не печатать их в выводе.
- Новый инструмент агента: `Tool` из `packages/core/src/tools/types.ts`, понятное description, JSON Schema параметров,
  `dangerous: true` для необратимого; результат — короткий текст (реестр обрезает до 20k символов).
