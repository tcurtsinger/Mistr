import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const markdownFiles = await walk(root);
const failures = [];

for (const file of markdownFiles) {
  const content = await readFile(file, "utf8");
  const links = content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of links) {
    const target = match[1].trim();
    if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
      continue;
    }

    const decoded = decodeURIComponent(target.split("#", 1)[0]);
    const resolved = resolve(dirname(file), decoded);
    try {
      await stat(resolved);
    } catch (error) {
      if (error.code === "ENOENT") {
        failures.push(`${relative(file)} -> ${target}`);
      } else {
        throw error;
      }
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Broken local Markdown links:\n${failures.join("\n")}`);
}

console.log(`Checked local links in ${markdownFiles.length} Markdown file(s).`);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "target") {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") files.push(path);
  }
  return files;
}

function relative(path) {
  return path.slice(root.length + 1).replaceAll("\\", "/");
}
