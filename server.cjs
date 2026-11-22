// Fichier de démarrage pour l'hébergement Node.js de cPanel / N0C (Phusion Passenger).
// Passenger charge ce fichier avec require() : l'API est en modules ES avec « await » au premier niveau,
// elle est donc chargée par import() dynamique.
// Les variables viennent du fichier .env placé à côté de ce fichier sur le serveur (jamais dans Git).
// Au démarrage, les migrations en attente sont appliquées (AUTO_MIGRATE=0 dans .env pour ne pas le faire).
const path = require('node:path');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* variables fournies par l'hébergeur */ }
process.env.NODE_ENV ??= 'production';

async function start() {
  if (process.env.AUTO_MIGRATE !== '0') {
    const { runMigrations } = await import('./src/lib/migrate.js');
    const applied = await runMigrations();
    if (applied.length) console.log(`Migrations appliquées au démarrage : ${applied.join(', ')}`);
  }
  await import('./src/index.js');
}

start().catch((err) => {
  console.error('Démarrage de l’API impossible :', err);
  process.exit(1);
});
