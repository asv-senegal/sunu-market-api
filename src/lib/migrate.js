// Applique les fichiers migrations/*.sql non encore appliqués, dans l'ordre.
// Utilisé par « npm run migrate » et au démarrage du serveur (server.cjs) : une mise en ligne par FTP
// suffit, la base est mise à jour au premier démarrage de la nouvelle version.
// Verrou PostgreSQL : si plusieurs processus démarrent ensemble, un seul applique les migrations.
// Une seule transaction : en cas d'erreur, rien n'est appliqué et l'API ne démarre pas (l'erreur est journalisée).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';

const dir = fileURLToPath(new URL('../../migrations', import.meta.url));

export async function runMigrations({ log = console.log } = {}) {
  return db.tx(async (t) => {
    await t.query(`SELECT pg_advisory_xact_lock(hashtext('sunu:migrate'))`);
    await t.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await t.many('SELECT name FROM schema_migrations')).map((r) => r.name));
    const applied = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await t.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await t.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      applied.push(f);
      log(`appliquée : ${f}`);
    }
    return applied;
  });
}
