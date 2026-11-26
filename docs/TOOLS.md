# Инструменты агента: контракты

Навыки в `skills/*/SKILL.md` ссылаются на инструменты по имени. Имена и аргументы ниже — договорённость между участниками:
A пишет навыки и проверяет их на живой модели, B реализует инструменты в harness. Меняем только вместе.

Общие правила для всех инструментов (`Tool` в `packages/core/src/tools/types.ts`):

- имя — `^[a-zA-Z0-9_-]{1,64}$`, аргументы — JSON Schema `type: "object"`, обязательные поля в `required`;
- `execute` возвращает текст для модели: короткий, без лишнего; структурированные данные — компактный JSON;
- ошибки — исключением с понятным сообщением: реестр вернёт модели `Ошибка инструмента …`, цикл не падает;
- длинный вывод обрезает реестр (20 000 символов), но лучше отдавать сразу нужное;
- действия с последствиями вне workspace помечаются `dangerous: true` — реестр сам спросит владельца;
- время — ISO 8601 с часовым поясом; владелец в Asia/Tomsk (UTC+7).

## Готово (A)

| Инструмент                                                  | Где                                         | Назначение                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `remember`, `recall_memory`, `forget_memory`, `set_profile` | `packages/memory/src/tools.ts`              | Долговременная память и профиль                                                                 |
| `marketplace_search`                                        | `packages/runtime/src/tools/marketplace.ts` | Поиск по Яндекс Маркету, Ozon и WB через сервис браузера; на капче/блокировке — в `unavailable` |
| `mcp__<сервер>__<инструмент>`                               | `packages/core/src/mcp/client.ts`           | Инструменты MCP-серверов из `config/mcp.json`                                                   |

## Готово (B)

Живые SearXNG, Radicale и Redis в среде, где писался код, не поднимались: интеграционные тесты
пропускаются, если сервиса нет. Расписание InTime сверено с сохранённым ответом API; живой
запрос в обычный `pnpm check` не входит (только при `TEST_INTIME=1`).

### Поиск (`skills/web-search`)

`integrations/src/search`: SearXNG (`SEARXNG_URL`, сервис `searxng` в compose) и `fetch_url`
с отсечением частных адресов. Текст страницы помечается как данные, не инструкции.

### Напоминания (`skills/reminders`)

`queue/src/reminders.ts`: одноразовые delayed jobs и cron из 5 полей в Asia/Tomsk.
Слушает очередь только worker. Срабатывание — задача `channel: "scheduler"`, текст `Напоминание: <text>`.

### Календарь (`skills/calendar`)

`integrations/src/calendar/caldav.ts` и `icsParse.ts` — свой CalDAV и VEVENT, без tsdav.
`calendar_list` сливает личный календарь и внешний источник, если он передан.
`calendar_delete` для `intime:` и `ext:` отвечает «только чтение».

| Инструмент        | Аргументы                                                                      | Результат                                 |
| ----------------- | ------------------------------------------------------------------------------ | ----------------------------------------- |
| `web_search`      | `query: string`, `limit?: number` (до 10)                                      | JSON-массив `{ title, url, snippet }`     |
| `fetch_url`       | `url: string`, `max_chars?: number`                                            | Заголовок, итоговый URL и текст страницы  |
| `create_reminder` | `text: string`, `at: string` (ISO 8601), `cron?: string` (5 полей, Asia/Tomsk) | `{ id, text, nextAt }`                    |
| `list_reminders`  | —                                                                              | JSON-массив `{ id, text, nextAt, cron? }` |
| `cancel_reminder` | `id: string`                                                                   | `"Отменено"` или ошибка                   |
| `calendar_list`   | `from: string`, `to: string`                                                   | JSON-массив `CalendarEvent`, по времени   |
| `calendar_add`    | `title`, `start`, `end?` (по умолчанию +1 ч), `location?`, `description?`      | `{ id, ... }` созданного события          |
| `calendar_delete` | `id: string`                                                                   | `"Удалено"`; для InTime — «только чтение» |
| `schedule`        | `from: string`, `to: string`                                                   | Только пары из InTime                     |

`CalendarEvent` — `packages/integrations/src/calendar/types.ts`.
Группа по умолчанию — `INTIME_DEFAULT_GROUP_ID` (972302), если `INTIME_GROUP_ID` пуст.
`calendar_list` подмешивает InTime, пока `EXTERNAL_CALENDAR_SOURCE` не `ics` и не `off`.

## Контракты, уже в коде

### Навыки и инструкции

| Инструмент   | Аргументы      | Результат                       |
| ------------ | -------------- | ------------------------------- |
| `load_skill` | `name: string` | Тело `SKILL.md` без frontmatter |

Рантайм (`packages/runtime`) вызывает `collectAgentsMd` и `discoverSkills` и кладёт результат в system prompt
(цепочка AGENTS.md целиком, у скиллов только name и description). Тело скилла модель берёт через `load_skill`.

### Файлы

| Инструмент     | Аргументы                               | Результат                                      |
| -------------- | --------------------------------------- | ---------------------------------------------- |
| `read_file`    | `path`, `start_line?`, `end_line?`      | Строки `N\|текст`                              |
| `write_file`   | `path`, `content`                       | Файл создан или перезаписан                    |
| `edit_file`    | `path`, `old`, `new`                    | Одна замена; `old` обязан встретиться один раз |
| `list_dir`     | `path?`, `depth?` (1–8, по умолчанию 2) | Дерево, с `.gitignore`, без секретов           |
| `search_files` | `query`, `path?`, `glob?`               | `путь:строка: текст`                           |

Путь вне workspace (`..`, абсолютный, симлинк наружу) выполняется только после подтверждения владельца.
`.env` (кроме `.env.example`), `.secrets` и файлы ключей не читаются и не пишутся.

### Оболочка и ОС

| Инструмент       | Аргументы                         | Результат                                        |
| ---------------- | --------------------------------- | ------------------------------------------------ |
| `shell`          | `command`, `timeout_sec?` (1–120) | Код, stdout, stderr. Каталог — workspace         |
| `os_info`        | —                                 | JSON: платформа, версия, архитектура, оболочка   |
| `list_processes` | —                                 | До 40 процессов той же среды, что и `shell`      |
| `open_url`       | `url` (только http/https)         | Открыть ссылку на хосте; всегда с подтверждением |

Linux — `bash -lc`, macOS — `zsh -lc`, Windows — `pwsh -NoProfile -NonInteractive -Command` (версия 7+, не Windows PowerShell 5.1), вывод в UTF-8.
Режим `SHELL_MODE=host` помечает `shell` как опасный. В окружение команды не попадают ключи, токены, пароли и `DATABASE_URL`.
Команды с `.env`, `.secrets` и ключами отклоняются. По таймауту убивается дерево процессов.
`SHELL_MODE=sandbox` (по умолчанию) — контейнер на сессию: `--network none`, `--read-only`, `--cap-drop ALL`, лимиты PID/RAM/CPU,
монтируется только workspace, `.env` и `.secrets` закрыты пустым томом. Перед запуском команда проходит allowlist, включая тело `bash -c` / `bash -lc`.

### Маркетплейсы

Адаптеры трёх площадок — `packages/integrations/src/marketplaces/{yandexMarket,ozon,wildberries}.ts`, список — `MARKETPLACES`
в `.env`. Страницы открывает сервис `browser` (`infra/browser`, `docker-compose up -d browser`, `BROWSER_URL`):
headless Chromium в отдельном контейнере, только публичный поиск трёх доменов, без входа и без stealth,
одна страница на сайт за `BROWSER_MIN_INTERVAL_MS` (10 с). Парсеры проверяются на фикстурах в `marketplaces/fixtures`
(у Ozon и WB выдача синтетическая — живую снять не удалось, страницы защиты настоящие).
