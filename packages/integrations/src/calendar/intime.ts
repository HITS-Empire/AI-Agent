import type { CalendarEvent, ExternalScheduleSource } from "./types";

/**
 * Расписание ТГУ из TSU.InTime (https://intime.tsu.ru). Публичный API без ключа, проверен 24.11.2026:
 * - GET /api/web/v1/faculties → [{ id, name }]
 * - GET /api/web/v1/faculties/{facultyId}/groups → [{ id, name, isSubgroup, facultyId }]
 * - GET /api/web/v1/schedule/group?id={groupId}&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
 *   → { grid: [{ date, lessons: [{ type: "LESSON" | "EMPTY", title, lessonType, starts, ends, professor, audience }] }] }
 * `starts`/`ends` — секунды от полуночи UTC (6300 = 01:45 UTC = 08:45 в Томске).
 * Документированного контракта нет, поэтому парсим осторожно и падаем с понятной ошибкой.
 */
export const INTIME_DEFAULT_BASE_URL = "https://intime.tsu.ru/api/web/v1";

/** Группа 972302, НОЦ «Высшая ИТ школа». Используется, если INTIME_GROUP_ID пуст. */
export const INTIME_DEFAULT_GROUP_ID = "ac6b8bef-2c83-11ee-8151-005056bc52bb";

interface InTimeLesson {
  type: string;
  id?: string;
  title?: string;
  lessonType?: string;
  starts?: number;
  ends?: number;
  professor?: { fullName?: string } | null;
  audience?: { name?: string; building?: { address?: string } | null } | null;
}

interface InTimeScheduleResponse {
  grid?: Array<{ date: string; lessons: InTimeLesson[] }>;
}

export interface InTimeFaculty {
  id: string;
  name: string;
}

export interface InTimeGroup {
  id: string;
  name: string;
  isSubgroup: boolean;
  facultyId: string;
}

export class InTimeSource implements ExternalScheduleSource {
  readonly name = "TSU.InTime";

  constructor(
    private readonly groupId: string,
    private readonly baseUrl = INTIME_DEFAULT_BASE_URL,
  ) {}

  /** Для выбора группы при настройке: факультеты. */
  async listFaculties(): Promise<InTimeFaculty[]> {
    return this.get<InTimeFaculty[]>("/faculties");
  }

  /** Для выбора группы при настройке: группы факультета. */
  async listGroups(facultyId: string): Promise<InTimeGroup[]> {
    return this.get<InTimeGroup[]>(
      `/faculties/${encodeURIComponent(facultyId)}/groups`,
    );
  }

  async getEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    const query = new URLSearchParams({
      id: this.groupId,
      dateFrom: tomskDateParam(from),
      dateTo: tomskDateParam(to),
    });
    const response = await this.get<InTimeScheduleResponse>(
      `/schedule/group?${query}`,
    );
    // API отдаёт целые дни, а контракт — интервал from/to. Лишнее отрезаем.
    return eventsInRange(parseInTimeSchedule(response), from, to);
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`InTime ${path}: HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }
}

/** Календарный день в Томске, а не UTC: полночь +07 не должна уезжать на предыдущие сутки. */
export function tomskDateParam(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tomsk",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function parseInTimeSchedule(
  response: InTimeScheduleResponse,
): CalendarEvent[] {
  if (!Array.isArray(response.grid)) {
    throw new Error("InTime: неожиданный формат ответа (нет grid)");
  }
  const events: CalendarEvent[] = [];
  for (const day of response.grid) {
    for (const lesson of day.lessons ?? []) {
      if (
        lesson.type !== "LESSON" ||
        lesson.starts === undefined ||
        lesson.ends === undefined
      ) {
        continue;
      }
      const location = [
        lesson.audience?.name,
        lesson.audience?.building?.address,
      ]
        .filter(Boolean)
        .join(", ");
      events.push({
        id: lesson.id ?? `${day.date}-${lesson.starts}`,
        title: lesson.title ?? "Занятие",
        start: atUtcSeconds(day.date, lesson.starts),
        end: atUtcSeconds(day.date, lesson.ends),
        location: location || undefined,
        description:
          [lesson.lessonType, lesson.professor?.fullName]
            .filter(Boolean)
            .join(" · ") || undefined,
        source: "TSU.InTime",
      });
    }
  }
  return events;
}

/** Событие попадает в полуинтервал [from, to): началось раньше конца и ещё не кончилось к началу. */
export function eventsInRange(
  events: CalendarEvent[],
  from: Date,
  to: Date,
): CalendarEvent[] {
  return events.filter((event) => {
    const start = new Date(event.start);
    const end = new Date(event.end);
    return start < to && end > from;
  });
}

function atUtcSeconds(date: string, seconds: number): string {
  return new Date(
    Date.parse(`${date}T00:00:00Z`) + seconds * 1000,
  ).toISOString();
}
