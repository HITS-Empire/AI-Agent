import { notImplemented } from "@burmalda/shared";

export interface SkillMeta {
  name: string;
  description: string;
  /** Путь к SKILL.md; тело читается лениво инструментом load_skill. */
  path: string;
}

/**
 * TODO(B): стандарт SKILL.md (Agent Skills): найти <dir>/<skill>/SKILL.md,
 * распарсить YAML-frontmatter (name, description) своим парсером, в prompt — только метаданные.
 */
export async function discoverSkills(_dirs: string[]): Promise<SkillMeta[]> {
  return notImplemented("поиск SKILL.md");
}
