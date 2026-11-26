import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type ResolveHost = (hostname: string) => Promise<string[]>;

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.internal",
]);

/** Публичный http(s). Частные адреса, localhost и метаданные облака закрыты. */
export async function assertPublicHttpUrl(
  raw: string,
  resolveHost: ResolveHost = resolvePublic,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Некорректный URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Разрешены только http и https");
  }
  if (url.username || url.password) {
    throw new Error("URL с логином и паролем не открываем");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !host ||
    BLOCKED_HOSTS.has(host) ||
    host.endsWith(".local") ||
    host.endsWith(".localhost")
  ) {
    throw new Error("Этот адрес закрыт");
  }
  const addresses = isIP(host) ? [host] : await resolveHost(host);
  if (addresses.length === 0) throw new Error("Адрес не резолвится");
  if (addresses.some(isPrivateIp)) throw new Error("Частные адреса закрыты");
  return url;
}

async function resolvePublic(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export function isPrivateIp(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIp(normalized.slice("::ffff:".length));
  }
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (normalized.includes(":")) {
    return !(normalized.startsWith("2") || normalized.startsWith("3"));
  }
  const parts = normalized.split(".");
  if (parts.length !== 4) return true;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = nums as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}
