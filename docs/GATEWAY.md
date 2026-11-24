# Шлюз моделей (LiteLLM) и маршрутизация

Все вызовы моделей «бурмалды» — чат, tool calling, compaction, извлечение фактов, эмбеддинги — идут
через LiteLLM Proxy (`http://127.0.0.1:4000`, конфиг `infra/litellm/config.yaml`). Код знает только
алиасы `burmalda-*` и виртуальный ключ `LITELLM_API_KEY`; провайдеры, ключи провайдеров и цены живут
только в конфиге шлюза.

## Алиасы и где они используются

| Алиас            | Провайдер                        | Где используется                                                      |
| ---------------- | -------------------------------- | --------------------------------------------------------------------- |
| `burmalda-main`  | `chatgpt/gpt-6.2-sol` (подписка) | цикл агента: ответы и tool calling (`runtime.ts`, `runAgent`)         |
| `burmalda-fast`  | `chatgpt/gpt-6.1-terra`          | summary при compaction (`ContextManager`), извлечение фактов в память |
| `burmalda-embed` | `ollama/bge-m3` (локально, 1024) | эмбеддинги долговременной памяти (`packages/memory`)                  |
| `burmalda-mock`  | `mock_response`, без провайдера  | разработка и e2e без подписки (участник B, CI)                        |

Алиасы переопределяются через `BURMALDA_MODEL_MAIN/FAST/EMBED` (`packages/shared/src/config.ts`).

## Маршрутизация, ретраи, таймауты

- **Fallback:** `burmalda-main` → `burmalda-fast` (`router_settings.fallbacks`), если основная модель
  не ответила после ретраев шлюза (лимит подписки, 5xx, таймаут). Проверено вживую запросом с
  `mock_testing_fallbacks` (флаг включался временно): заголовки ответа
  `x-litellm-model-group: burmalda-fast`, `x-litellm-attempted-fallbacks: 1`. Платный резерв
  `burmalda-main-fallback` (OpenRouter/OpenAI) описан в конфиге закомментированным.
- **Ретраи в шлюзе:** `num_retries: 2`, `timeout: 300` с.
- **Ретраи в клиенте** (`packages/core/src/llm/gatewayClient.ts`): до 3 повторов с экспоненциальной
  паузой 1/2/4 с на 408, 409, 429, 5xx и сетевые ошибки; таймаут попытки 300 с; отмена через
  `AbortSignal`. 4xx (кроме перечисленных) и `budget_exceeded` не повторяются.

## Бюджеты и учёт

- У `chatgpt/` нет цены в cost map, поэтому в конфиге заданы условные цены за токен
  (main $2/$8 за 1M вход/выход, fast $0.5/$2, embed 0). Без них spend был бы $0 и лимиты не работали бы.
- Глобальный потолок шлюза: `max_budget: 50`, `budget_duration: 30d`.
- Виртуальный ключ приложения — со своим лимитом (у нас $20/30d), создаётся через `/key/generate`
  мастер-ключом (README).
- Превышение бюджета: шлюз отвечает 422 `budget_exceeded`, клиент бросает `GatewayError` с
  `code: "budget_exceeded"` без ретраев, пользователь видит «Бюджет ключа шлюза исчерпан».
  Проверка вживую: `pnpm check:budget` — временный ключ с бюджетом $0.0005, первый вызов проходит,
  следующие отклоняются, ключ удаляется.
- Учёт токенов: `usage` каждого ответа и `x-litellm-response-cost` суммируются по задаче
  (`/usage` в CLI); источник истины по деньгам — spend-логи шлюза в Postgres.

## Логи и трейсы

- Шлюз пишет spend-логи с промптами в Postgres (`store_prompts_in_spend_logs`) и спаны в Phoenix
  (проект `burmalda-gateway`, callback `arize_phoenix`).
- Приложение пишет свои спаны в проект `burmalda` (задача → шаги → вызовы модели и инструментов,
  включая compaction) и JSON-логи с `traceId` задачи.

## Обход шлюза невозможен

- В коде нет SDK провайдеров и прямых URL моделей: единственный HTTP-клиент моделей —
  `createGatewayClient`; эмбеддинги тоже идут через `/v1/embeddings` шлюза.
- Порт Ollama не опубликован наружу из docker-compose — модель доступна только из сети шлюза.
- Токены подписки ChatGPT лежат в `.secrets/chatgpt/` и смонтированы только в контейнер шлюза.
- Проверка: `git grep -nE "api\.openai\.com|chatgpt\.com|:11434|from \"openai" -- packages apps scripts`
  ничего не находит.
