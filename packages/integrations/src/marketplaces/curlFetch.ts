import { execFile } from "node:child_process";

const MARKER = "\n__BURMALDA_CURL__";

/**
 * Минимальная замена fetch через системный curl (GET, без перехода по редиректам).
 * Нужна потому, что Маркет отдаёт капчу на запросы встроенного fetch (undici) с тем же
 * User-Agent, а на curl — обычную выдачу. Капчу это не решает: на showcaptcha адаптер останавливается.
 */
export const curlFetch: typeof fetch = (input, init) =>
  new Promise((resolve, reject) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const args = [
      "-s",
      "--compressed",
      "-m",
      "25",
      "-w",
      `${MARKER}%{http_code} %{redirect_url}`,
    ];
    const headers = new Headers(init?.headers);
    headers.forEach((value, key) => {
      if (key === "user-agent") args.push("-A", value);
      else args.push("-H", `${key}: ${value}`);
    });
    args.push(url);

    const child = execFile(
      "curl",
      args,
      { maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error) return reject(new TypeError(`curl: ${error.message}`));
        const at = stdout.lastIndexOf(MARKER);
        if (at < 0) return reject(new TypeError("curl: неожиданный вывод"));
        const [code = "0", location = ""] = stdout
          .slice(at + MARKER.length)
          .trim()
          .split(" ");
        const status = Number(code);
        const body = [204, 304].includes(status) ? null : stdout.slice(0, at);
        resolve(
          new Response(body, {
            status: status >= 200 && status <= 599 ? status : 502,
            headers: location ? { location } : {},
          }),
        );
      },
    );
    init?.signal?.addEventListener("abort", () => child.kill(), { once: true });
  });
