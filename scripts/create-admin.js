// Crée ou promeut un compte administrateur.
// Usage : npm run create-admin --workspace apps/api -- "+221XXXXXXXXX" "MotDePasseSolide" "Prénom" "Nom"
import bcrypt from 'bcryptjs';
import { db } from '../src/db.js';
import { normalizePhone } from '../src/lib/text.js';

const [phoneIn, password, first = 'Admin', last = 'Sunu-Market'] = process.argv.slice(2);
const phone = normalizePhone(phoneIn);
if (!phone || !password || password.length < 12) {
  console.error('Usage : create-admin <téléphone sénégalais> <mot de passe de 12 caractères minimum> [prénom] [nom]');
  process.exit(1);
}
await db.query(
  `INSERT INTO users (first_name, last_name, phone, password_hash, role, verification_status, consent_at)
   VALUES ($1,$2,$3,$4,'admin','verified',now())
   ON CONFLICT (phone) DO UPDATE SET role = 'admin', verification_status = 'verified', password_hash = EXCLUDED.password_hash`,
  [first, last, phone, await bcrypt.hash(password, 12)]);
console.log(`administrateur prêt : ${phone}`);
await db.end();
