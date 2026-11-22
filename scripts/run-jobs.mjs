// Exécute une fois les tâches de fond puis s'arrête : à lancer par une tâche cron (toutes les 5 minutes).
// Sur un hébergement Passenger (cPanel / N0C), l'application est mise en veille sans visiteurs : les minuteries
// internes ne sont pas fiables. Dans ce cas, mettez JOBS_DISABLED=1 dans .env et utilisez ce script.
// Les verrous PostgreSQL empêchent tout doublon si le serveur et le cron tournent en même temps.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* variables déjà fournies */ }

const { reconcilePayments, sendSubscriptionReminders } = await import('../src/lib/jobs.js');
const { purgeIdempotencyKeys } = await import('../src/lib/idempotency.js');
const { db } = await import('../src/db.js');

const stamp = new Date().toISOString();
let failed = false;
for (const [name, fn] of [['rapprochement', reconcilePayments], ['rappels', sendSubscriptionReminders], ['nettoyage', purgeIdempotencyKeys]]) {
  try {
    const r = await fn();
    const summary = r?.rowCount !== undefined ? { supprimées: r.rowCount } : r;
    console.log(`${stamp} [${name}] ${JSON.stringify(summary)}`);
  } catch (e) {
    failed = true;
    console.error(`${stamp} [${name}] échec : ${e.message}`);
  }
}
await db.end();
// Laisse partir les SMS de notification envoyés en arrière-plan
setTimeout(() => process.exit(failed ? 1 : 0), 2000);
