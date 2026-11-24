import { notImplemented } from "@burmalda/shared";
import type { PersonalCalendar } from "./types";

export interface CalDavOptions {
  /** Коллекция календаря, например http://127.0.0.1:5232/owner/personal/ (Radicale из docker-compose). */
  url: string;
  username: string;
  password: string;
}

/**
 * Личный календарь по CalDAV (RFC 4791). Сервер — свой Radicale в docker-compose.
 * TODO(B): REPORT calendar-query по диапазону, PUT .ics для создания, DELETE; можно взять tsdav — это harness, не ядро.
 */
export function createCalDavCalendar(
  _options: CalDavOptions,
): PersonalCalendar {
  return notImplemented("CalDAV-клиент");
}
