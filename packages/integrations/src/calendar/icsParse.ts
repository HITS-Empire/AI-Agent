/**
 * Свой разбор VEVENT: без RRULE и без YAML/ICS-библиотек.
 * Время пишем в Asia/Tomsk (UTC+7, без перехода).
 */

const TOMSK_OFFSET_MINUTES = 7 * 60;

const ZONE_OFFSETS: Record<string, number> = {
  "Asia/Tomsk": TOMSK_OFFSET_MINUTES,
  "Europe/Moscow": 3 * 60,
  UTC: 0,
  GMT: 0,
};

export interface ParsedEvent {
  uid: string;
  title: string;
  start: Date;
  end: Date;
  location?: string;
  description?: string;
}

export function parseIcs(text: string): ParsedEvent[] {
  const unfolded = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
  const events: ParsedEvent[] = [];
  const blocks = unfolded.split(/BEGIN:VEVENT/i).slice(1);
  for (const block of blocks) {
    const body = block.split(/END:VEVENT/i)[0] ?? "";
    const props = parseProps(body);
    const startRaw = props.get("DTSTART");
    if (!startRaw) continue;
    const start = parseWhen(startRaw.value, startRaw.params);
    const endRaw = props.get("DTEND");
    const end = endRaw
      ? parseWhen(endRaw.value, endRaw.params)
      : new Date(start.getTime() + 60 * 60 * 1000);
    const uid =
      props.get("UID")?.value || `${start.toISOString()}-${events.length}`;
    events.push({
      uid: unescapeText(uid),
      title: unescapeText(props.get("SUMMARY")?.value ?? "Событие"),
      start,
      end,
      location: optional(props.get("LOCATION")?.value),
      description: optional(props.get("DESCRIPTION")?.value),
    });
  }
  return events;
}

export function overlaps(event: ParsedEvent, from: Date, to: Date): boolean {
  return event.start < to && event.end > from;
}

export function formatEventIcs(event: {
  uid: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//burmalda//calendar//RU",
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Tomsk",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0700",
    "TZOFFSETTO:+0700",
    "TZNAME:KRAT",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    `UID:${escapeText(event.uid)}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART;TZID=Asia/Tomsk:${tomskStamp(event.start)}`,
    `DTEND;TZID=Asia/Tomsk:${tomskStamp(event.end)}`,
    `SUMMARY:${escapeText(event.title)}`,
  ];
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.description)
    lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

interface Prop {
  value: string;
  params: Map<string, string>;
}

function parseProps(body: string): Map<string, Prop> {
  const props = new Map<string, Prop>();
  for (const line of body.split(/\r?\n/)) {
    if (!line || line.startsWith("BEGIN:") || line.startsWith("END:")) continue;
    const split = line.indexOf(":");
    if (split < 0) continue;
    const left = line.slice(0, split);
    const value = line.slice(split + 1);
    const [name, ...rawParams] = left.split(";");
    const params = new Map<string, string>();
    for (const param of rawParams) {
      const eq = param.indexOf("=");
      if (eq > 0)
        params.set(param.slice(0, eq).toUpperCase(), param.slice(eq + 1));
    }
    props.set(name!.toUpperCase(), { value, params });
  }
  return props;
}

function parseWhen(value: string, params: Map<string, string>): Date {
  if (/^\d{8}$/.test(value)) {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(4, 6));
    const day = Number(value.slice(6, 8));
    return zoned(year, month, day, 0, 0, 0, TOMSK_OFFSET_MINUTES);
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!match) throw new Error(`ICS: не разобрать дату ${value}`);
  const parts = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (match[7] === "Z") return zoned(...parts, 0);
  const tz = params.get("TZID");
  if (!tz) return zoned(...parts, TOMSK_OFFSET_MINUTES);
  const offset = ZONE_OFFSETS[tz];
  if (offset === undefined)
    throw new Error(`ICS: неизвестный часовой пояс ${tz}`);
  return zoned(...parts, offset);
}

function zoned(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  offsetMinutes: number,
): Date {
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute, second) -
      offsetMinutes * 60_000,
  );
}

function tomskStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()))
    throw new Error("Некорректная дата события");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tomsk",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  let hour = pick("hour");
  if (hour === "24") hour = "00";
  return `${pick("year")}${pick("month")}${pick("day")}T${hour}${pick("minute")}${pick("second")}`;
}

function stamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function unescapeText(value: string): string {
  const slash = "\uE000";
  return value
    .replace(/\\\\/g, slash)
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replaceAll(slash, "\\");
}

function optional(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = unescapeText(value).trim();
  return text || undefined;
}
