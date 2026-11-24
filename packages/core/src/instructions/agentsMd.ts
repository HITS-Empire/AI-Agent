import { notImplemented } from "../errors";

export interface AgentsMdFile {
  path: string;
  content: string;
}

/**
 * TODO(B): стандарт AGENTS.md (https://agents.md): собрать файлы от корня workspace до cwd,
 * более глубокие — приоритетнее; вернуть в порядке «общий → частный» для system prompt.
 */
export async function collectAgentsMd(
  _workspaceRoot: string,
  _cwd: string,
): Promise<AgentsMdFile[]> {
  return notImplemented("чтение AGENTS.md");
}
