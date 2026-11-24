/**
 * Календарные интеграции работают без LLM: это обычные API-клиенты.
 * Инструменты агента (`schedule_today`, `calendar_add` и т. п.) — тонкие обёртки над ними.
 */

export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO 8601 с часовым поясом. */
  start: string;
  end: string;
  location?: string;
  description?: string;
  source: string;
}

/** Внешний календарь только на чтение: расписание вуза, турниры и т. п. */
export interface ExternalScheduleSource {
  readonly name: string;
  getEvents(from: Date, to: Date): Promise<CalendarEvent[]>;
}

/** Личный календарь: чтение и запись. */
export interface PersonalCalendar {
  listEvents(from: Date, to: Date): Promise<CalendarEvent[]>;
  createEvent(
    event: Omit<CalendarEvent, "id" | "source">,
  ): Promise<CalendarEvent>;
  deleteEvent(id: string): Promise<void>;
}
