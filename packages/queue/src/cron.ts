/** Пять полей cron, ближайший запуск в Asia/Tomsk (UTC+7, без перехода). */

const TOMSK = "Asia/Tomsk";

export function assertCron(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("cron — ровно 5 полей: минута час день месяц день_недели");
  }
  const limits = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ] as const;
  fields.forEach((field, index) =>
    parseField(field, limits[index]![0], limits[index]![1]),
  );
  return fields.join(" ");
}

export function nextCronRun(expression: string, from = new Date()): Date {
  const cron = assertCron(expression);
  const fields = cron.split(" ");
  const minute = parseField(fields[0]!, 0, 59);
  const hour = parseField(fields[1]!, 0, 23);
  const dom = parseField(fields[2]!, 1, 31);
  const month = parseField(fields[3]!, 1, 12);
  const dow = parseField(fields[4]!, 0, 7);
  if (dow.has(7)) dow.add(0);
  const domRestricted = fields[2] !== "*";
  const dowRestricted = fields[4] !== "*";
  const start = Math.ceil((from.getTime() + 1) / 60_000) * 60_000;
  for (let step = 0; step < 366 * 24 * 60; step += 1) {
    const date = new Date(start + step * 60_000);
    const parts = tomskParts(date);
    if (
      !minute.has(parts.minute) ||
      !hour.has(parts.hour) ||
      !month.has(parts.month)
    ) {
      continue;
    }
    const domOk = dom.has(parts.day);
    const dowOk = dow.has(parts.weekday);
    const dayOk =
      domRestricted && dowRestricted ? domOk || dowOk : domOk && dowOk;
    if (dayOk) return date;
  }
  throw new Error("Нет ближайшего срабатывания cron");
}

function parseField(spec: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    const stepMatch = /^(\*|\d+(?:-\d+)?)\/(\d+)$/.exec(part);
    const range = stepMatch ? stepMatch[1]! : part;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`cron: плохой шаг в ${spec}`);
    }
    let from = min;
    let to = max;
    if (range !== "*") {
      const bounds = /^(\d+)(?:-(\d+))?$/.exec(range);
      if (!bounds) throw new Error(`cron: не разобрать ${spec}`);
      from = Number(bounds[1]);
      to = bounds[2] === undefined ? from : Number(bounds[2]);
    }
    if (from < min || to > max || from > to) {
      throw new Error(`cron: ${spec} вне ${min}-${max}`);
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  if (values.size === 0) throw new Error(`cron: пустое поле ${spec}`);
  return values;
}

function tomskParts(date: Date): {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TOMSK,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let hour = Number(pick("hour"));
  if (hour === 24) hour = 0;
  return {
    minute: Number(pick("minute")),
    hour,
    day: Number(pick("day")),
    month: Number(pick("month")),
    weekday: weekdays.indexOf(pick("weekday")),
  };
}
