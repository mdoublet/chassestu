// Génère db/neon-console.sql : toutes les migrations en un seul script, à
// coller dans l'éditeur SQL de la console Neon quand `npm run db:migrate`
// n'est pas utilisable. Le script enregistre aussi les migrations dans
// schema_migrations (mêmes sommes de contrôle que migrate.mjs), pour que
// `npm run db:migrate` reste utilisable ensuite.
// Usage : node db/bundle.mjs
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(root, 'migrations');
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

let out = `-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- À exécuter UNE FOIS sur une base vide, dans l'éditeur SQL de Neon.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
`;
for (const file of files) {
  const sql = await readFile(path.join(dir, file), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  out += `\n-- ==================== ${file} ====================\n${sql}\n`;
  out += `INSERT INTO schema_migrations (name, checksum) VALUES ('${file}', '${checksum}');\n`;
}
out += '\nCOMMIT;\n';
await writeFile(path.join(root, 'neon-console.sql'), out);
console.log(`db/neon-console.sql : ${files.length} migration(s)`);
