#!/usr/bin/env node
/**
 * Verifies every relative link and image in the project's markdown.
 *
 * The docs were split out of a single 544-line README, which moved a lot of
 * paths at once. On a public repo a dead link is visible to everyone, and
 * nothing else in the toolchain checks them.
 *
 *   node scripts/check-links.mjs
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', 'dist', 'admin']);

/** Every tracked markdown file, minus vendored and build output. */
function markdownFiles(dir = ROOT, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) markdownFiles(full, found);
    } else if (entry.name.endsWith('.md')) {
      found.push(full);
    }
  }
  return found;
}

const files = markdownFiles();
let checked = 0;
const broken = [];

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  // Strip fenced code blocks: a path inside an example is not a link.
  const body = src.replace(/```[\s\S]*?```/g, '');

  for (const m of body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;

    const [pathPart] = target.split('#');
    if (!pathPart) continue;

    // Root-relative links resolve from the repo root, the rest from the file.
    const abs = pathPart.startsWith('/')
      ? join(ROOT, pathPart.slice(1))
      : resolve(dirname(file), pathPart);

    checked++;
    if (!existsSync(abs)) {
      broken.push({ file: relative(ROOT, file), target, reason: 'does not exist' });
    } else if (statSync(abs).isDirectory() && !pathPart.endsWith('/')) {
      // A directory link is fine, just note it resolves to a folder.
      continue;
    }
  }
}

console.log(`\nChecked ${checked} relative links across ${files.length} markdown files.`);
if (broken.length) {
  console.log('');
  for (const b of broken) console.log(`  BROKEN  ${b.file} -> ${b.target}  (${b.reason})`);
  console.log(`\n${broken.length} broken link(s).`);
  process.exit(1);
}
console.log('All relative links resolve.\n');
