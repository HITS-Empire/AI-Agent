import { notImplemented } from "@burmalda/shared";
import type { ShellRunner } from "./types";

export {
  detectHostShell,
  type HostShell,
  type ShellResult,
  type ShellRunOptions,
  type ShellRunner,
} from "./types";
export {
  commandTouchesSecrets,
  createHostRunner,
  hostInvocation,
  killTree,
  parsePwshMajor,
  sanitizedEnv,
  type HostRunnerOptions,
} from "./host";
export { openInvocation, openOnHost } from "./open";

/**
 * TODO(B): контейнер сессии `docker run -d --network none --read-only --cap-drop ALL
 * --pids-limit 256 --memory 1g --cpus 1 -v <workspace>:/workspace <image>`, затем `docker exec bash -lc`.
 */
export function createSandboxRunner(_options: {
  image: string;
  workspaceDir: string;
  sessionId: string;
}): ShellRunner {
  return notImplemented("песочница");
}
