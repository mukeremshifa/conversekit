#!/usr/bin/env node
/**
 * Refuses to deploy if a scratch harness is sitting in public/.
 *
 * `wrangler pages deploy public` uploads the directory as it finds it, so a
 * file that git ignores still goes live. One did: public/__shot.html, a
 * screenshot harness with seeded fake messages, was served from the site root.
 *
 * npm runs this automatically before `deploy:pages`.
 */
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const stray = existsSync(PUBLIC)
  ? readdirSync(PUBLIC).filter((f) => f.startsWith('__'))
  : [];

if (stray.length) {
  console.error('\nRefusing to deploy — scratch files are still in public/:\n');
  for (const f of stray) console.error(`  public/${f}`);
  console.error('\nDelete them and run again.\n');
  process.exit(1);
}
console.log('public/ is clean — no scratch harnesses.');
