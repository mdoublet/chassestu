// Scripts SQL à coller dans l'éditeur SQL de la console Neon, quand
// `npm run db:migrate` n'est pas utilisable :
//   db/neon-console.sql            toutes les migrations (base vide)
//   db/neon-updates/<migration>    une seule migration (base existante)
// Chaque script s'exécute en une transaction, enregistre la migration dans
// schema_migrations (mêmes sommes de contrôle que migrate.mjs) et refuse de
// s'exécuter deux fois ou si la migration précédente manque.
// Usage : node db/bundle.mjs
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(root, 'migrations');
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

const header = (what) => `-- GÉNÉRÉ par db/bundle.mjs — ne pas modifier à la main.
-- ${what}
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
`;

const quote = (s) => `'${s.replace(/'/g, "''")}'`;

function guard(file, previous) {
  return `
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = ${quote(file)}) THEN
    RAISE EXCEPTION 'La migration % est déjà appliquée : rien à faire.', ${quote(file)};
  END IF;${
    previous
      ? `
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = ${quote(previous)}) THEN
    RAISE EXCEPTION 'Appliquez d''abord la migration %.', ${quote(previous)};
  END IF;`
      : ''
  }
END $guard$;
`;
}

async function block(file) {
  const sql = await readFile(path.join(dir, file), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  return `\n-- ==================== ${file} ====================\n${sql}\nINSERT INTO schema_migrations (name, checksum) VALUES (${quote(file)}, '${checksum}');\n`;
}

let all = header('À exécuter UNE FOIS sur une base vide, dans l’éditeur SQL de Neon.');
for (const file of files) all += guard(file, null) + (await block(file));
await writeFile(path.join(root, 'neon-console.sql'), `${all}\nCOMMIT;\n`);

await mkdir(path.join(root, 'neon-updates'), { recursive: true });
for (const [i, file] of files.entries()) {
  const out = header(`Mise à jour d’une base existante : migration ${file} seule.`) + guard(file, files[i - 1] ?? null) + (await block(file));
  await writeFile(path.join(root, 'neon-updates', file), `${out}\nCOMMIT;\n`);
}
console.log(`db/neon-console.sql et db/neon-updates/ : ${files.length} migration(s)`);
