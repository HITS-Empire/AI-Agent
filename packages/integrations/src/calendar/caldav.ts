import type { CalendarEvent, PersonalCalendar } from "./types";
import { formatEventIcs, overlaps, parseIcs } from "./icsParse";

export interface CalDavOptions {
  /** Коллекция календаря, например http://127.0.0.1:5232/owner/personal/ */
  url: string;
  username: string;
  password: string;
  fetchImpl?: typeof fetch;
}

/**
 * Личный календарь по CalDAV (RFC 4791) без tsdav.
 * Пароль уходит только в Authorization и не пишется в ошибки.
 */
export function createCalDavCalendar(options: CalDavOptions): PersonalCalendar {
  const fetchImpl = options.fetchImpl ?? fetch;
  const collection = options.url.endsWith("/")
    ? options.url
    : `${options.url}/`;

  const request = async (
    url: string,
    init: RequestInit & { method: string },
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    const token = Buffer.from(
      `${options.username}:${options.password}`,
      "utf8",
    ).toString("base64");
    headers.set("authorization", `Basic ${token}`);
    return fetchImpl(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  };

  const ensureCollection = async (): Promise<void> => {
    const probe = await request(collection, {
      method: "PROPFIND",
      headers: { depth: "0", "content-type": "application/xml" },
      body: PROPFIND,
    });
    if (probe.ok || probe.status === 207) return;
    if (probe.status !== 404) {
      throw new Error(await caldavError(probe, options.password));
    }
    const created = await request(collection, {
      method: "MKCALENDAR",
      headers: { "content-type": "application/xml" },
    });
    if (!created.ok && created.status !== 201 && created.status !== 405) {
      throw new Error(await caldavError(created, options.password));
    }
  };

  return {
    async listEvents(from, to) {
      await ensureCollection();
      const response = await request(collection, {
        method: "PROPFIND",
        headers: { depth: "1", "content-type": "application/xml" },
        body: PROPFIND,
      });
      if (!response.ok && response.status !== 207) {
        throw new Error(await caldavError(response, options.password));
      }
      const xml = await response.text();
      const events: CalendarEvent[] = [];
      // Radicale на PROPFIND не отдаёт calendar-data (свойство 404). Тогда читаем .ics по ссылкам.
      const bodies = extractCalendarData(xml);
      if (bodies.length === 0) {
        const origin = new URL(collection).origin;
        for (const href of extractHrefs(xml)) {
          const file = await request(new URL(href, origin).href, {
            method: "GET",
          });
          if (file.ok) bodies.push(await file.text());
        }
      }
      for (const ics of bodies) {
        for (const event of parseIcs(ics)) {
          if (!overlaps(event, from, to)) continue;
          events.push({
            id: event.uid,
            title: event.title,
            start: event.start.toISOString(),
            end: event.end.toISOString(),
            location: event.location,
            description: event.description,
            source: "caldav",
          });
        }
      }
      events.sort((a, b) => a.start.localeCompare(b.start));
      return events;
    },

    async createEvent(event) {
      await ensureCollection();
      const id = crypto.randomUUID();
      const body = formatEventIcs({
        uid: id,
        title: event.title,
        start: event.start,
        end: event.end,
        location: event.location,
        description: event.description,
      });
      const response = await request(
        `${collection}${encodeURIComponent(id)}.ics`,
        {
          method: "PUT",
          headers: { "content-type": "text/calendar; charset=utf-8" },
          body,
        },
      );
      if (!response.ok && response.status !== 201 && response.status !== 204) {
        throw new Error(await caldavError(response, options.password));
      }
      return { ...event, id, source: "caldav" };
    },

    async deleteEvent(id) {
      const response = await request(
        `${collection}${encodeURIComponent(id)}.ics`,
        { method: "DELETE" },
      );
      if (response.status === 404) throw new Error("Событие не найдено");
      if (!response.ok && response.status !== 204) {
        throw new Error(await caldavError(response, options.password));
      }
    },
  };
}

const PROPFIND = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><C:calendar-data/></D:prop>
</D:propfind>`;

/** Ссылки на объекты календаря из PROPFIND. Коллекция сама в список не входит. */
export function extractHrefs(xml: string): string[] {
  const hrefs: string[] = [];
  const pattern = /<(?:[\w.-]+:)?href[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?href>/gi;
  for (const match of xml.matchAll(pattern)) {
    const href = unescapeXml(match[1] ?? "").trim();
    if (href.toLowerCase().endsWith(".ics")) hrefs.push(href);
  }
  return hrefs;
}

export function extractCalendarData(xml: string): string[] {
  const found: string[] = [];
  const pattern =
    /<(?:[\w.-]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?calendar-data>/gi;
  for (const match of xml.matchAll(pattern)) {
    let body = match[1] ?? "";
    body = body.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
    found.push(unescapeXml(body).trim());
  }
  return found.filter(Boolean);
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&");
}

async function caldavError(
  response: Response,
  password: string,
): Promise<string> {
  const raw = await response.text().catch(() => "");
  const cleaned = password ? raw.replaceAll(password, "***") : raw;
  const snippet = cleaned.replace(/\s+/g, " ").trim().slice(0, 180);
  return snippet
    ? `CalDAV HTTP ${response.status}: ${snippet}`
    : `CalDAV HTTP ${response.status}`;
}
