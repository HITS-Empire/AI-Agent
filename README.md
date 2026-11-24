# бурмалда

Персональный ИИ-ассистент: самописное ядро агента (цикл, нативный tool calling, MCP, compaction) и harness
(LLM-шлюз LiteLLM, память на pgvector, Telegram + CLI с общей очередью, Docker-песочница, трассировка в Phoenix,
личный календарь на Radicale, расписание ТГУ из TSU.InTime).

Учебный проект, Т-Банк Образование, практика 2.5, модуль 1. Задание — [docs/ASSIGNMENT.md](docs/ASSIGNMENT.md),
план — [docs/PLAN.md](docs/PLAN.md), правила разработки — [AGENTS.md](AGENTS.md).

## Требования

- Node 22+ и pnpm 10 (`corepack enable` или `corepack pnpm@10.34.9 …`)
- Docker: на macOS — [OrbStack](https://orbstack.dev) (`brew install orbstack`), он легче Docker Desktop
- Подписка ChatGPT с Codex (Plus/Pro/Business) — только для работы с живой моделью. Без неё всё, кроме ответов модели,
  работает на заглушке `burmalda-mock` (см. «Без подписки»)

## Быстрый старт

```bash
pnpm install
cp .env.example .env            # заполнить LITELLM_MASTER_KEY, LITELLM_SALT_KEY (openssl rand -hex 32)
pnpm sandbox:build              # образ песочницы
mkdir -p .secrets/chatgpt .secrets/radicale
printf 'owner:%s\n' "$(openssl rand -hex 16)" > .secrets/radicale/users   # пароль для Radicale → CALDAV_PASSWORD в .env
pnpm infra:up                   # postgres+pgvector, redis, litellm, phoenix, ollama, radicale
docker compose exec ollama ollama pull bge-m3   # модель эмбеддингов для памяти
```

Если что-то не стартует:

- `docker: command not found` после установки OrbStack — старая ссылка `/usr/local/bin/docker` от Docker Desktop.
  Удалить её или добавить в PATH `/Applications/OrbStack.app/Contents/MacOS/xbin`; вместо `docker compose` подойдёт `docker-compose`.
- Порт 5432 занят локальным PostgreSQL — в `.env` задать `POSTGRES_PORT=5433` и поправить порт в `DATABASE_URL`.
- `docker.litellm.ai` отвечает 502 — взять образ с GitHub: `LITELLM_IMAGE=ghcr.io/berriai/litellm`, `LITELLM_TAG=main-stable`.

### Вход в ChatGPT для шлюза (один раз)

LiteLLM ходит в модели по подписке ChatGPT через провайдер `chatgpt/` ([документация](https://docs.litellm.ai/docs/providers/chatgpt)).
Шлюз не может сам пройти device-code вход, поэтому логинимся заранее, токены попадают в `.secrets/chatgpt/auth.json`:

```bash
docker compose run --rm --no-deps --entrypoint python \
  litellm -c "from litellm.llms.chatgpt.authenticator import Authenticator; Authenticator().get_access_token()"
docker compose restart litellm
```

Открыть ссылку, войти, ввести код. Перед этим в настройках безопасности ChatGPT должен быть разрешён вход по device code.

Важно:

- Это отдельный логин, **не** `~/.codex/auth.json`: refresh-токен одноразовый, общий файл сломает Codex CLI.
- Подписку одного человека нельзя использовать для запросов другого (условия OpenAI), поэтому вход делается только
  на машине владельца подписки.

### Без подписки

В `.env` поставить `BURMALDA_MODEL_MAIN=burmalda-mock`: шлюз отвечает фиксированным текстом и не ходит к провайдеру.
Учёт, ключи, очередь, интерфейсы и логи работают как обычно. Сценарии с вызовами инструментов тестируются в коде
через `FakeLlmClient` из `@burmalda/core`.

### Ключ приложения с бюджетом

```bash
curl -s http://127.0.0.1:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H "Content-Type: application/json" \
  -d '{"key_alias":"burmalda-app","max_budget":20,"budget_duration":"30d","models":["burmalda-main","burmalda-fast","burmalda-embed"]}'
```

Полученный ключ — в `LITELLM_API_KEY` в `.env`. Бюджет считается в «условных долларах» по ценам из `infra/litellm/config.yaml`.

### Запуск

```bash
pnpm dev:cli -- --direct   # рантайм агента прямо в CLI: память, compaction, инструменты; /usage — расход
pnpm dev:worker            # worker с циклом агента (очередь)
pnpm dev:telegram          # Telegram-бот (нужны TELEGRAM_BOT_TOKEN и TELEGRAM_OWNER_ID)
```

## Где смотреть

| Что                                      | Адрес                    |
| ---------------------------------------- | ------------------------ |
| LiteLLM Admin UI: ключи, бюджеты, расход | http://localhost:4000/ui |
| Phoenix: трассировка вызовов             | http://localhost:6006    |
| Radicale: личный календарь (CalDAV)      | http://localhost:5232    |

## Проверки

```bash
pnpm check   # typecheck + eslint + prettier + тесты
pnpm test    # только тесты (node:test, сценарии на FakeLlmClient, без токенов)

# интеграционные тесты на живых Postgres и Redis из compose
TEST_DATABASE_URL="$DATABASE_URL" TEST_REDIS_URL=redis://127.0.0.1:6379 pnpm test
```
