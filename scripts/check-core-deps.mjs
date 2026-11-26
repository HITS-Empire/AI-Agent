// Проверка условия лабы «ядро без библиотек»: у packages/core нет зависимостей ни прямо, ни транзитивно.
// 1) в package.json ядра нет dependencies/peerDependencies/optionalDependencies;
// 2) все импорты в исходниках ядра — только node:* или относительные пути внутри packages/core.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const coreDir = join(root, "packages/core");
const errors = [];

const pkg = JSON.parse(readFileSync(join(coreDir, "package.json"), "utf8"));
for (const field of [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "bundledDependencies",
]) {
  const deps = Object.keys(pkg[field] ?? {});
  if (deps.length)
    errors.push(`package.json: ${field} не пуст: ${deps.join(", ")}`);
}

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(c|m)?[jt]s$/.test(name)) files.push(path);
  }
};
walk(join(coreDir, "src"));

const IMPORT_RE =
  /(?:^|[^.\w])(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']|(?:^|[^.\w])import\s*["']([^"']+)["']|(?:^|[^.\w])(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gm;

for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3];
    const where = relative(root, file);
    if (spec.startsWith("node:")) continue;
    if (spec.startsWith("./") || spec.startsWith("../")) {
      const target = resolve(dirname(file), spec);
      const boundary = coreDir.endsWith(sep) ? coreDir : `${coreDir}${sep}`;
      if (target !== coreDir && !target.startsWith(boundary))
        errors.push(`${where}: относительный импорт за пределы ядра: ${spec}`);
      continue;
    }
    errors.push(`${where}: внешний импорт «${spec}»`);
  }
}

if (errors.length) {
  console.error(`Ядро должно быть без зависимостей:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(
  `packages/core: 0 зависимостей, ${files.length} файлов, импорты только node:* и свои модули`,
);
