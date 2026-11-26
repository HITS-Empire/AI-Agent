import { spawn } from "node:child_process";

/** Открыть http(s)-ссылку на хосте. Аргумент передаётся массивом, не через оболочку. */
export function openOnHost(url: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("open_url принимает только http и https");
  }
  const invocation = openInvocation(process.platform, url);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.cmd, invocation.args, {
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            `нечем открыть ссылку: нет команды ${invocation.cmd}. На Linux нужен xdg-open`,
          ),
        );
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (code && code !== 0) {
        reject(new Error(`${invocation.cmd} завершился с кодом ${code}`));
        return;
      }
      resolve(`открыто: ${url}`);
    });
  });
}

export function openInvocation(
  os: NodeJS.Platform,
  url: string,
): { cmd: string; args: string[] } {
  if (os === "darwin") return { cmd: "open", args: [url] };
  if (os === "win32") {
    return {
      cmd: "pwsh",
      args: ["-NoProfile", "-Command", "Start-Process $args[0]", url],
    };
  }
  return { cmd: "xdg-open", args: [url] };
}
