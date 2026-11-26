// Historique FICTIF de démonstration (à lancer après `npm run seed -- --demo`) :
// 12 mois de commandes terminées, avis réciproques, abonnements et recharges SM-IA payés, dossiers de vérification
// et signalements en attente. Toutes les personnes et tous les numéros sont fictifs (série +221 70 000 01 xx).
// Les tarifs de mise en avant, campagne et publicité restant [à confirmer], aucun paiement de ce type n'est inventé.
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../src/db.js';
import { config } from '../src/config.js';

if (config.env === 'production') { console.error('Refusé en production : données fictives.'); process.exit(1); }

// Générateur pseudo-aléatoire déterministe : même historique à chaque exécution
let seed = 20261125;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const daysAgo = (d, h = between(9, 19)) => { const t = new Date(Date.now() - d * 864e5); t.setUTCHours(h, between(0, 59), 0, 0); return t; };

if (await db.one(`SELECT 1 FROM users WHERE phone = '+221700000101'`)) { console.log('Historique déjà présent.'); await db.end(); process.exit(0); }

const hash = await bcrypt.hash(process.env.SEED_DEMO_PASSWORD || 'Sunu2026!', 10);
const BUYERS = [['Khady', 'Diallo', 'Médina'], ['Ousmane', 'Sy', 'Pikine'], ['Mariama', 'Kane', 'Ouakam'], ['Cheikh', 'Seck', 'Plateau'], ['Ndèye', 'Gueye', 'Grand Yoff'],
  ['Babacar', 'Thiam', 'Parcelles Assainies'], ['Aïssatou', 'Bâ', 'Sacré-Cœur'], ['Modou', 'Faye', 'Guédiawaye'], ['Seynabou', 'Diouf', 'Liberté'], ['Lamine', 'Cissé', 'Yoff']];
const buyers = [];
for (const [i, [fn, ln, q]] of BUYERS.entries()) {
  const created = daysAgo(between(200, 360));
  const u = await db.one(`INSERT INTO users (first_name, last_name, phone, password_hash, quarter, verification_status, consent_at, created_at, updated_at, phone_verified_at)
    VALUES ($1,$2,$3,$4,$5,'verified',$6,$6,$6,$6) RETURNING id`, [fn, ln, `+2217000001${String(i + 1).padStart(2, '0')}`, hash, q, created]);
  buyers.push(u.id);
}

const shops = await db.many(`SELECT s.id, s.owner_id, s.name FROM shops s`);
const TAGS_B = ['Article Conforme', 'Ponctuel', 'Très Aimable', 'Bon Emballage', 'Bonne Communication', 'Prix Juste'];
const TAGS_S = ['Ponctuel', 'Paiement Rapide', 'Aimable', 'Bonne Communication'];
const COMMENTS = ['Très belles finitions, rendez-vous respecté.', 'Article conforme à la photo, merci.', 'Vendeur sérieux, je recommande.', 'Échange rapide dans SM-Chat.', null, null];
const PLACES = ['Marché Sandaga, entrée principale', 'Marché de Colobane', 'Parcelles Assainies, U15', 'Marché HLM', 'Rond-point Liberté 6'];
const PAYS = ['wave', 'wave', 'orange_money', 'cash'];
let orders = 0, reviews = 0;

for (const s of shops) {
  const listings = await db.many(`SELECT id, title, price_fcfa FROM listings WHERE shop_id = $1 AND status = 'active'`, [s.id]);
  if (!listings.length) continue;
  // Ventes croissantes sur 12 mois (la boutique se fait connaître)
  for (let d = 360; d >= 2; d -= between(3, 9)) {
    const l = pick(listings); const qty = rnd() < 0.8 ? 1 : 2; const buyer = pick(buyers);
    const created = daysAgo(d); const done = new Date(created.getTime() + between(1, 3) * 864e5);
    if (rnd() < (d > 180 ? 0.35 : 0.1)) continue;
    const o = await db.one(`INSERT INTO orders (listing_id, buyer_id, seller_id, title_snapshot, unit_price_fcfa, quantity, total_fcfa, delivery_mode, pay_method, meeting_place, meeting_at, status, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'hand',$8,$9,$10,'completed',$11,$10) RETURNING id`,
      [l.id, buyer, s.owner_id, l.title, l.price_fcfa, qty, l.price_fcfa * qty, pick(PAYS), pick(PLACES), done, created]);
    orders++;
    if (rnd() < 0.75) {
      await db.query(`INSERT INTO reviews (order_id, author_id, target_id, rating, tags, comment, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [o.id, buyer, s.owner_id, rnd() < 0.8 ? 5 : 4, TAGS_B.filter(() => rnd() < 0.35), pick(COMMENTS), done]);
      await db.query(`INSERT INTO reviews (order_id, author_id, target_id, rating, tags, created_at) VALUES ($1,$2,$3,5,$4,$5)`,
        [o.id, s.owner_id, buyer, TAGS_S.filter(() => rnd() < 0.4), done]);
      reviews += 2;
    }
  }
  // Commandes en cours : une nouvelle, une remise prévue aujourd'hui
  const l1 = pick(listings), l2 = pick(listings);
  await db.query(`INSERT INTO orders (listing_id, buyer_id, seller_id, title_snapshot, unit_price_fcfa, quantity, total_fcfa, delivery_mode, pay_method, status, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,1,$5,'hand','wave','new', now() - interval '3 hours', now() - interval '3 hours')`, [l1.id, pick(buyers), s.owner_id, l1.title, l1.price_fcfa]);
  const today = new Date(); today.setUTCHours(17, 0, 0, 0);
  await db.query(`INSERT INTO orders (listing_id, buyer_id, seller_id, title_snapshot, unit_price_fcfa, quantity, total_fcfa, delivery_mode, pay_method, meeting_place, meeting_at, status, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,1,$5,'hand','cash',$6,$7,'scheduled', now() - interval '1 day', now() - interval '20 hours')`, [l2.id, pick(buyers), s.owner_id, l2.title, l2.price_fcfa, pick(PLACES), today]);
  orders += 2;
  await db.query(`UPDATE listings SET views = views + $2 WHERE shop_id = $1`, [s.id, between(40, 160)]);
}
await db.query(`UPDATE listings SET views = views + floor(random() * 120)::int`);

// Revenus de la plateforme : abonnements annuels et recharges SM-IA payés sur 6 mois
let pay = 0;
const ref = async (p) => `${p}-${(await db.one(`SELECT nextval('payment_seq') n`)).n}`;
for (const [i, b] of buyers.entries()) {
  // Les acheteurs fictifs 1 à 6 ont aussi ouvert une petite boutique (essai puis abonnement)
  if (i > 5) continue;
  const paid = daysAgo(between(5, 170));
  const sh = await db.one(`INSERT INTO shops (owner_id, slug, name, quarter, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [b, `boutique-demo-${i + 1}`, `Boutique ${BUYERS[i][0]}`, BUYERS[i][2], new Date(paid.getTime() - 14 * 864e5)]);
  const p = await db.one(`INSERT INTO payments (ref, user_id, shop_id, purpose, amount_fcfa, total_fcfa, provider, provider_ref, status, paid_at, created_at, updated_at)
    VALUES ($1,$2,$3,'subscription',2500,2500,$4,$5,'paid',$6,$6,$6) RETURNING id`, [await ref('AB'), b, sh.id, pick(['wave', 'orange_money']), `DEMO-${i}`, paid]);
  await db.query(`INSERT INTO subscriptions (shop_id, kind, amount_fcfa, starts_at, ends_at, status, payment_id) VALUES ($1,'annual',2500,$2,$2::timestamptz + interval '1 year','active',$3)`, [sh.id, paid, p.id]);
  pay++;
}
for (let k = 0; k < 14; k++) {
  const u = pick([...shops.map((s) => s.owner_id), ...buyers.slice(0, 6)]);
  const amount = pick([2000, 5000, 10000]); const commission = Math.round(amount / 100);
  const paid = daysAgo(between(1, 175));
  await db.query(`INSERT INTO payments (ref, user_id, purpose, amount_fcfa, commission_fcfa, total_fcfa, credits, provider, provider_ref, status, paid_at, created_at, updated_at)
    VALUES ($1,$2,'credits',$3,$4,$5,$6,$7,$8,'paid',$9,$9,$9)`, [await ref('IA'), u, amount, commission, amount + commission, amount * 4, pick(['wave', 'orange_money']), `DEMO-IA-${k}`, paid]);
  pay++;
}

// Dossiers de vérification en attente (illustrations fictives, jamais de vraie pièce ni de vrai visage)
const sample = await db.one(`SELECT doc_file, selfie_file FROM verifications WHERE doc_file IS NOT NULL LIMIT 1`);
const PENDING = [['Cheikh', 'Sow', 'Plateau', 38], ['Aïssatou', 'Ndour', 'Ouakam', 65], ['Modou', 'Fall', 'Pikine', 130], ['Seynabou', 'Diatta', 'Médina', 220]];
for (const [i, [fn, ln, q, min]] of PENDING.entries()) {
  const at = new Date(Date.now() - min * 6e4);
  const u = await db.one(`INSERT INTO users (first_name, last_name, phone, password_hash, quarter, verification_status, consent_at, created_at, phone_verified_at)
    VALUES ($1,$2,$3,$4,$5,'pending',$6,$6,$6) RETURNING id`, [fn, ln, `+2217000002${String(i + 1).padStart(2, '0')}`, hash, q, at]);
  let doc = null, selfie = null;
  if (sample) for (const [src, set] of [[sample.doc_file, (v) => { doc = v; }], [sample.selfie_file, (v) => { selfie = v; }]]) {
    if (!src || !fs.existsSync(src)) continue;
    const dest = path.join(path.dirname(src), `demo-${i}-${path.basename(src)}`);
    fs.copyFileSync(src, dest); set(dest);
  }
  await db.query(`INSERT INTO verifications (user_id, doc_type, doc_file, selfie_file, submitted_at) VALUES ($1,$2,$3,$4,$5)`, [u.id, pick(['cni', 'cni', 'passport']), doc, selfie, at]);
}

// Deux signalements d'annonces en attente d'examen
const ls = await db.many(`SELECT l.id, s.owner_id FROM listings l JOIN shops s ON s.id = l.shop_id WHERE l.status = 'active' ORDER BY l.price_fcfa DESC LIMIT 2`);
for (const [i, l] of ls.entries()) {
  await db.query(`INSERT INTO reports (reporter_id, target_type, target_id, reason, details, reported_user_id, created_at) VALUES ($1,'listing',$2,$3,$4,$5, now() - $6::interval)`,
    [buyers[i], l.id, i ? 'prohibited' : 'scam', i ? 'Article qui semble interdit à la vente.' : 'Prix anormalement bas, photo reprise d’un autre site.', l.owner_id, `${10 + i * 30} hours`]);
}

console.log(`Historique fictif ajouté : ${buyers.length} acheteurs, ${orders} commandes, ${reviews} avis, ${pay} paiements, ${PENDING.length} vérifications, ${ls.length} signalements.`);
await db.end();
