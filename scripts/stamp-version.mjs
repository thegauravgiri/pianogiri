// Copies the site into an output folder and adds ?v=<version> to every local
// script, module import, worker and stylesheet reference.
//
// Why: Cloudflare tells browsers to cache files for hours, and each file
// expires on its own. Without unique URLs a browser can run a new app.js with
// an old worker (or the reverse) right after a release. With them, a page load
// is always one consistent version.
//
// Usage: node scripts/stamp-version.mjs <outDir> <version>
import fs from "node:fs";
import path from "node:path";

const [outDir, version] = process.argv.slice(2);
if (!outDir || !version) {
  console.error("Usage: node scripts/stamp-version.mjs <outDir> <version>");
  process.exit(1);
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const skip = new Set([".git", ".github", ".claude", "scripts", "youtube-service", "node_modules", outDir, "README.md", ".gitignore", ".DS_Store"]);
const tag = `?v=${version}`;

// Local (./ or ../) .js/.css references in the forms this site uses.
const patterns = [
  /(\bfrom\s*["'])(\.{1,2}\/[^"'?]+\.js)(["'])/g, // import x from "./a.js"
  /(\bimport\s*["'])(\.{1,2}\/[^"'?]+\.js)(["'])/g, // import "./a.js"
  /(\bimport\(\s*["'])(\.{1,2}\/[^"'?]+\.js)(["']\s*\))/g, // import("./a.js")
  /(new URL\(\s*["'])(\.{1,2}\/[^"'?]+\.js)(["'])/g, // new URL("./worker.js", import.meta.url)
  /(<script[^>]+src=["'])(\.{0,2}\/?[^"':?]+\.js)(["'])/g, // <script src="./app.js">
  /(<link[^>]+href=["'])(\.{0,2}\/?[^"':?]+\.css)(["'])/g, // <link href="./styles.css">
];

let stamped = 0;
function stamp(text) {
  for (const re of patterns) {
    text = text.replace(re, (_m, a, url, b) => {
      stamped += 1;
      return `${a}${url}${tag}${b}`;
    });
  }
  return text;
}

function copy(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (src === root && skip.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copy(from, to);
    else if (/\.(js|html)$/.test(entry.name)) fs.writeFileSync(to, stamp(fs.readFileSync(from, "utf8")));
    else fs.copyFileSync(from, to);
  }
}

const out = path.resolve(root, outDir);
fs.rmSync(out, { recursive: true, force: true });
copy(root, out);
console.log(`Stamped ${stamped} references with ${tag} into ${outDir}/`);
