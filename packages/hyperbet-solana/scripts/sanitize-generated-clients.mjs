import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const generatedRoot = path.resolve(scriptsDir, "../app/src/generated");

function typescriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return typescriptFiles(entryPath);
      return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
    })
    .sort();
}

let changed = 0;
for (const filepath of typescriptFiles(generatedRoot)) {
  const source = readFileSync(filepath, "utf8");
  const sanitized = source.replace(/[ \t]+(?=\r?$)/gm, "");
  if (sanitized !== source) {
    writeFileSync(filepath, sanitized);
    changed += 1;
  }
}

console.log(
  `[sanitize-generated-clients] removed trailing whitespace from ${changed} generated file(s)`,
);
