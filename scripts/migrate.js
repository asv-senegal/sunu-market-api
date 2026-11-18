import { fileURLToPath } from 'node:url';
// Applique les fichiers migrations/*.sql non encore appliqués, dans l'ordre.
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../src/db.js';

const dir = fileURLToPath(new URL('../migrations', import.meta.url));
await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
const done = new Set((await db.many('SELECT name FROM schema_migrations')).map((r) => r.name));
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  if (done.has(f)) continue;
  const sql = fs.readFileSync(path.join(dir, f), 'utf8');
  await db.tx(async (t) => {
    await t.query(sql);
    await t.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
  });
  console.log('appliquée :', f);
}
console.log('migrations à jour');
await db.end();
