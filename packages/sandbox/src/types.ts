import { platform } from "node:os";

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ShellRunOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ShellRunner {
  readonly kind: "sandbox" | "host";
  /** Человекочитаемое имя оболочки: «bash (docker)», «pwsh 7», «zsh». */
  readonly shellName: string;
  run(command: string, options?: ShellRunOptions): Promise<ShellResult>;
}

export type HostShell = "pwsh" | "bash" | "zsh";

/**
 * Какую оболочку использовать на хосте: Windows → PowerShell 7+ (pwsh, не Windows PowerShell 5.1),
 * macOS → zsh, Linux → bash.
 */
export function detectHostShell(os: NodeJS.Platform = platform()): HostShell {
  if (os === "win32") return "pwsh";
  if (os === "darwin") return "zsh";
  return "bash";
}
