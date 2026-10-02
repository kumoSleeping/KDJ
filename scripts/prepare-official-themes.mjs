// Rebuild runtime file digests for downloadable official themes.
// Theme assets live outside public/ and are never imported by the application bundle.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../themes/official/", import.meta.url));
async function filesIn(dir) {
  const paths = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      for (const child of await filesIn(join(dir, entry.name))) paths.push(`${entry.name}/${child}`);
    } else if (entry.isFile()) paths.push(entry.name);
    else throw new Error(`Unsupported theme entry: ${join(dir, entry.name)}`);
  }
  return paths.sort();
}
for (const id of ["sakulaptop98"]) {
  const path = join(root, id, "theme.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const files = (await filesIn(dirname(path))).filter(file => file !== "theme.json");
  manifest.files = Object.fromEntries(await Promise.all(files.map(async file => [
    file, createHash("sha256").update(await readFile(join(root, id, file))).digest("hex"),
  ])));
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${manifest.name}: ${files.length} files`);
}
