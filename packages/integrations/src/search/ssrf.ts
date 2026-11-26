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
  const normalized = ip.toLowerCase().split("%")[0] ?? "";
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIp(normalized.slice("::ffff:".length));
  }
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (normalized.includes(":")) {
    const groups = expandIpv6(normalized);
    if (!groups) return true;
    // 6to4 (2002::/16) прячет IPv4 в следующих двух группах.
    if (groups[0] === 0x2002) {
      return isPrivateIp(ipv4FromGroups(groups[1] ?? 0, groups[2] ?? 0));
    }
    // Teredo (2001:0::/32) — туннель, не открываем.
    if (groups[0] === 0x2001 && groups[1] === 0) return true;
    // Глобальная адресация — 2000::/3. Остальное (ULA, link-local, multicast) закрыто.
    const first = groups[0] ?? 0;
    return first < 0x2000 || first > 0x3fff;
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

/** Восемь групп IPv6. Неразборчивый адрес — null, вызывающий считает его закрытым. */
function expandIpv6(ip: string): number[] | null {
  if (ip.includes(".")) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const groups = part.split(":");
    const nums: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      nums.push(Number.parseInt(group, 16));
    }
    return nums;
  };
  const left = parse(halves[0] ?? "");
  if (!left) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const right = parse(halves[1] ?? "");
  if (!right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

function ipv4FromGroups(high: number, low: number): string {
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}
