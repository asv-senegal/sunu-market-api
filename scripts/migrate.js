// Applique les migrations en attente (voir src/lib/migrate.js).
import { runMigrations } from '../src/lib/migrate.js';
import { db } from '../src/db.js';

await runMigrations();
console.log('migrations à jour');
await db.end();
