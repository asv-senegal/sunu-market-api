// Charge les 12 catégories et 93 sous-catégories, puis (option --demo) des données fictives.
// Toutes les personnes, boutiques et numéros de démonstration sont fictifs.
import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import { db } from '../src/db.js';
import { slugify } from '../src/lib/text.js';

const taxonomy = JSON.parse(fs.readFileSync(new URL('./taxonomy.json', import.meta.url), 'utf8'));
const demo = process.argv.includes('--demo');

await db.tx(async (t) => {
  for (const [i, c] of taxonomy.entries()) {
    const slug = slugify(c.name);
    const cat = await t.one(
      `INSERT INTO categories (slug, name, icon, position, is_shops) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, icon = EXCLUDED.icon, position = EXCLUDED.position, is_shops = EXCLUDED.is_shops
       RETURNING id`,
      [slug, c.name, c.icon, i, slug === 'boutiques'],
    );
    for (const [j, s] of c.subs.entries()) {
      const items = s.items.replace(/\s*\[[^\]]*\]/g, '').split(/,\s*/).map((x) => x.trim()).filter(Boolean);
      await t.query(
        `INSERT INTO subcategories (category_id, slug, name, items, source, position) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (category_id, slug) DO UPDATE SET name = EXCLUDED.name, items = EXCLUDED.items, source = EXCLUDED.source, position = EXCLUDED.position`,
        [cat.id, slugify(s.name), s.name, items, s.src, j],
      );
    }
  }
});
const n = await db.one('SELECT (SELECT count(*) FROM categories) c, (SELECT count(*) FROM subcategories) s');
console.log(`catalogue : ${n.c} catégories, ${n.s} sous-catégories`);

if (demo) {
  const pass = process.env.SEED_DEMO_PASSWORD || 'Sunu2026!';
  const hash = await bcrypt.hash(pass, 10);
  const sub = async (cat, name) => (await db.one(
    'SELECT s.id FROM subcategories s JOIN categories c ON c.id = s.category_id WHERE c.slug = $1 AND s.slug = $2',
    [cat, slugify(name)],
  )).id;

  // Numéros fictifs (série +221 70 000 00 xx, non attribuée à des personnes réelles)
  const people = [
    ['Admin', 'Sunu-Market', '+221700000001', 'admin', 'Plateau'],
    ['Awa', 'Diop', '+221700000011', 'member', 'Médina'],
    ['Moussa', 'Ndiaye', '+221700000012', 'member', 'Parcelles Assainies'],
    ['Fatou', 'Sarr', '+221700000013', 'member', 'Sacré-Cœur'],
    ['Ibrahima', 'Fall', '+221700000014', 'member', 'Grand Yoff'],
    ['Aminata', 'Ba', '+221700000015', 'member', 'Ouakam'],
  ];
  const ids = {};
  for (const [fn, ln, phone, role, q] of people) {
    const u = await db.one(
      `INSERT INTO users (first_name, last_name, phone, password_hash, quarter, role, verification_status, consent_at)
       VALUES ($1,$2,$3,$4,$5,$6,'verified',now())
       ON CONFLICT (phone) DO UPDATE SET first_name = EXCLUDED.first_name RETURNING id`,
      [fn, ln, phone, hash, q, role],
    );
    ids[fn] = u.id;
  }

  const shops = [
    ['Awa', 'Atelier Awa Couture', 'Tenues sur mesure en wax et bazin, retouches rapides.', 'Médina', 'femmes', 'tailor_sewing'],
    ['Moussa', 'Moussa Tech', 'Téléphones et accessoires testés, garantie entre membres.', 'Parcelles Assainies', 'electronique', 'phone_table'],
    ['Fatou', 'Fatou Beauté', 'Soins naturels au karité et cosmétiques locaux.', 'Sacré-Cœur', 'femmes', 'cream_top'],
    ['Ibrahima', 'Vannerie Fall', 'Paniers et objets tressés à la main à Dakar.', 'Grand Yoff', 'artisanat', 'baskets_stack'],
  ];
  const shopIds = {};
  for (const [owner, name, desc, q, uni, banner] of shops) {
    const cat = await db.one('SELECT id FROM categories WHERE slug = $1', [uni]);
    const s = await db.one(
      `INSERT INTO shops (owner_id, slug, name, description, quarter, universe, banner) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (owner_id) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [ids[owner], slugify(name), name, desc, q, cat.id, `/demo/${banner}.jpg`],
    );
    shopIds[owner] = s.id;
    // Crédits SM-IA de l'essai (barème proposé : 500 crédits)
    await db.query(`INSERT INTO credit_wallets (user_id, balance) VALUES ($1, 500) ON CONFLICT (user_id) DO NOTHING`, [ids[owner]]);
    await db.query(`INSERT INTO credit_ledger (user_id, delta, kind, note, balance_after) SELECT $1, 500, 'grant_trial', 'Crédits SM-IA offerts pendant l’essai', 500
      WHERE NOT EXISTS (SELECT 1 FROM credit_ledger WHERE user_id = $1)`, [ids[owner]]);
    await db.query(
      `INSERT INTO subscriptions (shop_id, kind, amount_fcfa, starts_at, ends_at, status)
       SELECT $1, 'trial', 0, now(), now() + interval '14 days', 'active'
       WHERE NOT EXISTS (SELECT 1 FROM subscriptions WHERE shop_id = $1)`,
      [s.id],
    );
  }

  const L = [
    ['Awa', 'femmes', 'Tenues Traditionnelles', 'Boubou en bazin brodé, taille M', 35000, 'new', 'print_dress', true],
    ['Awa', 'femmes', 'Vêtements', 'Robe en wax coupe évasée', 15000, 'new', 'white_dress', false],
    ['Awa', 'hommes', 'Tenues Traditionnelles', 'Grand boubou homme, bazin riche', 45000, 'new', 'fabric_stacks', false],
    ['Moussa', 'electronique', 'Téléphones', 'Smartphone Android 128 Go, très bon état', 85000, 'like_new', 'phone_dark', true],
    ['Moussa', 'electronique', 'Accessoires Téléphone', 'Chargeur rapide et câble USB-C', 5000, 'new', 'phone_people', false],
    ['Moussa', 'electronique', 'Téléphones', 'Téléphone d’entrée de gamme, double SIM', 32000, 'good', 'dakar_phone', false],
    ['Fatou', 'femmes', 'Beauté', 'Beurre de karité pur, pot de 250 g', 3500, 'new', 'cream_jar', true],
    ['Fatou', 'femmes', 'Beauté', 'Crème hydratante au karité et baobab', 6000, 'new', 'cream_gold', false],
    ['Fatou', 'femmes', 'Beauté', 'Coffret soins naturels, trois produits', 12500, 'new', 'cream_yellow', false],
    ['Ibrahima', 'artisanat', 'Vannerie', 'Panier tressé multicolore, grand modèle', 9000, 'new', 'baskets_red', false],
    ['Ibrahima', 'artisanat', 'Vannerie', 'Lot de trois paniers de rangement', 15000, 'new', 'baskets_angola', true],
    ['Ibrahima', 'artisanat', 'Bijoux Artisanaux', 'Bracelets en perles, faits main', 2500, 'new', 'beads_bracelets', false],
    ['Awa', 'femmes', 'Chaussures', 'Sandales en cuir artisanales, pointure 39', 8000, 'new', 'sandals_olive', false],
    ['Moussa', 'maison-et-bureau', 'Meubles', 'Canapé trois places, tissu beige', 120000, 'good', 'living_room', false],
    ['Ibrahima', 'livres-et-loisirs', 'Livres', 'Lot de romans africains, dix livres', 10000, 'good', 'books_stack', false],
    ['Moussa', 'sports-et-sante', 'Football', 'Ballon de football taille 5', 7500, 'new', 'football', false],
  ];
  const have = await db.one('SELECT count(*)::int n FROM listings');
  if (have.n === 0) {
    for (const [owner, cat, s, title, price, cond, img, featured] of L) {
      const l = await db.one(
        `INSERT INTO listings (shop_id, subcategory_id, title, description, price_fcfa, condition, featured_until, stock)
         VALUES ($1,$2,$3,$4,$5,$6,$7,3) RETURNING id`,
        [shopIds[owner], await sub(cat, s), title, `${title}. Remise en main propre à Dakar ou livraison à convenir via SM-Chat.`, price, cond,
          featured ? new Date(Date.now() + 7 * 864e5) : null],
      );
      await db.query('INSERT INTO listing_photos (listing_id, url, position) VALUES ($1,$2,0)', [l.id, `/demo/${img}.jpg`]);
    }
  }
  console.log(`données de démonstration chargées (mot de passe des comptes fictifs : ${pass})`);
}
await db.end();
