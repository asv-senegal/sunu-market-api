import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { notFound, forbidden, bad } from '../lib/http.js';
import { requireVerified } from '../lib/auth.js';
import { listingUpload, removeFile } from '../lib/upload.js';
import { VISIBLE, currentSubscription, sellerRating, PROMO } from '../lib/shop.js';
import { optimize } from '../lib/images.js';
import { triggerModeration } from '../lib/smia.js';

const r = Router();

// ---------- Catégories (menu principal) ----------
r.get('/categories', async (_req, res) => {
  const rows = await db.many(
    `SELECT c.id, c.slug, c.name, c.icon, c.is_shops,
       coalesce(json_agg(json_build_object('id', s.id, 'slug', s.slug, 'name', s.name, 'items', s.items) ORDER BY s.position)
         FILTER (WHERE s.id IS NOT NULL), '[]') subs
     FROM categories c LEFT JOIN subcategories s ON s.category_id = c.id AND NOT s.hidden
     GROUP BY c.id ORDER BY c.position`);
  res.set('Cache-Control', 'public, max-age=300').json({ items: rows });
});

// ---------- Annonces ----------
const CARD = `l.id, l.title, l.price_fcfa, l.condition, l.created_at, (l.featured_until > now()) featured, ${PROMO} promo_price_fcfa,
  sh.name shop_name, sh.slug shop_slug, sh.quarter,
  (SELECT url FROM listing_photos p WHERE p.listing_id = l.id ORDER BY position LIMIT 1) photo`;

r.get('/listings', async (req, res) => {
  const q = z.object({
    q: z.string().trim().max(100).optional(),
    category: z.string().optional(), sub: z.string().optional(),
    quarter: z.string().optional(), shop: z.string().optional(),
    min: z.coerce.number().int().min(0).optional(), max: z.coerce.number().int().min(0).optional(),
    condition: z.enum(['new', 'like_new', 'good', 'fair']).optional(),
    sort: z.enum(['relevance', 'recent', 'price_asc', 'price_desc']).default('relevance'),
    page: z.coerce.number().int().min(1).default(1),
  }).parse(req.query);
  const where = [VISIBLE]; const p = [];
  const add = (sql, v) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
  if (q.q) add(`l.search @@ plainto_tsquery('french', ?)`, q.q);
  if (q.category) add('c.slug = ?', q.category);
  if (q.sub) add('s.slug = ?', q.sub);
  if (q.quarter) add('sh.quarter = ?', q.quarter);
  if (q.shop) add('sh.slug = ?', q.shop);
  if (q.min != null) add('l.price_fcfa >= ?', q.min);
  if (q.max != null) add('l.price_fcfa <= ?', q.max);
  if (q.condition) add('l.condition = ?', q.condition);
  const order = { relevance: '(l.featured_until > now()) DESC NULLS LAST, l.created_at DESC', recent: 'l.created_at DESC',
    price_asc: 'l.price_fcfa ASC', price_desc: 'l.price_fcfa DESC' }[q.sort];
  const from = `FROM listings l JOIN shops sh ON sh.id = l.shop_id JOIN subcategories s ON s.id = l.subcategory_id JOIN categories c ON c.id = s.category_id
    WHERE ${where.join(' AND ')}`;
  const per = 24;
  const [items, total] = await Promise.all([
    db.many(`SELECT ${CARD} ${from} ORDER BY ${order} LIMIT ${per} OFFSET ${(q.page - 1) * per}`, p),
    db.one(`SELECT count(*)::int n ${from}`, p),
  ]);
  res.json({ items, total: total.n, page: q.page, pages: Math.max(1, Math.ceil(total.n / per)) });
});

r.get('/listings/:id', async (req, res) => {
  if (!z.uuid().safeParse(req.params.id).success) throw notFound('Annonce introuvable.');
  const l = await db.one(
    `SELECT l.*, (l.featured_until > now()) featured, ${PROMO} promo_price_fcfa,
       json_build_object('slug', s.slug, 'name', s.name) sub, json_build_object('slug', c.slug, 'name', c.name) category,
       json_build_object('id', sh.id, 'slug', sh.slug, 'name', sh.name, 'quarter', sh.quarter, 'ownerId', sh.owner_id, 'since', sh.created_at,
         'rating', ${sellerRating}) shop,
       (SELECT json_agg(url ORDER BY position) FROM listing_photos p WHERE p.listing_id = l.id) photos,
       (${VISIBLE}) visible
     FROM listings l JOIN shops sh ON sh.id = l.shop_id JOIN subcategories s ON s.id = l.subcategory_id JOIN categories c ON c.id = s.category_id
     WHERE l.id = $1`, [req.params.id]);
  const owner = l && req.user?.id === l.shop.ownerId;
  const staff = ['admin', 'moderator'].includes(req.user?.role);
  if (!l || (!l.visible && !owner && !staff)) throw notFound('Annonce introuvable.');
  if (!owner) db.query('UPDATE listings SET views = views + 1 WHERE id = $1', [l.id]).catch(() => {});
  delete l.search;
  res.json({ listing: l });
});

const listingBody = z.object({
  subcategoryId: z.coerce.number().int(),
  title: z.string().trim().min(5).max(90),
  description: z.string().trim().max(3000).default(''),
  priceFcfa: z.coerce.number().int().min(0).max(100_000_000),
  condition: z.enum(['new', 'like_new', 'good', 'fair']),
  stock: z.coerce.number().int().min(0).max(9999).default(1),
  delivery: z.preprocess((v) => [].concat(v ?? 'hand'), z.array(z.enum(['hand', 'delivery', 'pickup'])).min(1)),
  payMethods: z.preprocess((v) => [].concat(v ?? []), z.array(z.enum(['wave', 'orange_money', 'cash'])).min(1, 'Choisissez au moins un moyen de paiement.')),
});

async function myShopOrFail(userId) {
  const shop = await db.one('SELECT * FROM shops WHERE owner_id = $1', [userId]);
  if (!shop) throw forbidden('Créez d’abord votre boutique.', 'no_shop');
  return shop;
}

r.post('/listings', requireVerified, listingUpload.array('photos', 6), async (req, res) => {
  const files = req.files || [];
  try {
    const b = listingBody.parse(req.body);
    const draft = req.body.draft === '1' || req.body.draft === 'true';
    const shop = await myShopOrFail(req.user.id);
    if (!(await currentSubscription(db, shop.id))) throw forbidden('Votre abonnement a expiré. Renouvelez-le pour publier.', 'subscription_expired');
    if (!files.length) throw bad('Ajoutez au moins une photo.', 'photo_required');
    const sub = await db.one('SELECT s.id FROM subcategories s JOIN categories c ON c.id = s.category_id WHERE s.id = $1 AND NOT c.is_shops', [b.subcategoryId]);
    if (!sub) throw bad('Sous-catégorie invalide.', 'subcategory');
    for (const f of files) await optimize(f);
    const l = await db.tx(async (t) => {
      const l = await t.one(
        `INSERT INTO listings (shop_id, subcategory_id, title, description, price_fcfa, condition, stock, delivery, pay_methods, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [shop.id, b.subcategoryId, b.title, b.description, b.priceFcfa, b.condition, b.stock, b.delivery, b.payMethods, draft ? 'draft' : 'active']);
      for (const [i, f] of files.entries()) await t.query('INSERT INTO listing_photos (listing_id, url, position) VALUES ($1,$2,$3)', [l.id, `/files/listings/${f.filename}`, i]);
      return l;
    });
    if (!draft) triggerModeration(l.id);
    res.status(201).json({ id: l.id, draft });
  } catch (e) { files.forEach((f) => removeFile(f.path)); throw e; }
});

r.patch('/listings/:id', requireVerified, async (req, res) => {
  const shop = await myShopOrFail(req.user.id);
  const b = listingBody.partial().extend({ status: z.enum(['active', 'paused', 'sold']).optional() }).parse(req.body);
  if (b.status === 'active' && !(await currentSubscription(db, shop.id))) throw forbidden('Votre abonnement a expiré. Renouvelez-le pour publier.', 'subscription_expired');
  const cols = { subcategoryId: 'subcategory_id', title: 'title', description: 'description', priceFcfa: 'price_fcfa', condition: 'condition',
    stock: 'stock', delivery: 'delivery', payMethods: 'pay_methods', status: 'status' };
  const sets = []; const p = [req.params.id, shop.id];
  for (const [k, c] of Object.entries(cols)) if (b[k] !== undefined && req.body[k] !== undefined) { p.push(b[k]); sets.push(`${c} = $${p.length}`); }
  if (!sets.length) throw bad('Aucune modification.');
  const l = await db.one(`UPDATE listings SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND shop_id = $2 AND status <> 'removed' RETURNING id, status`, p);
  if (!l) throw notFound('Annonce introuvable.');
  res.json({ listing: l });
});

r.delete('/listings/:id', requireVerified, async (req, res) => {
  const shop = await myShopOrFail(req.user.id);
  const l = await db.one(`UPDATE listings SET status = 'removed', updated_at = now() WHERE id = $1 AND shop_id = $2 RETURNING id`, [req.params.id, shop.id]);
  if (!l) throw notFound('Annonce introuvable.');
  res.json({ ok: true });
});

// ---------- Boutiques ----------
r.get('/shops', async (req, res) => {
  const q = z.object({ quarter: z.string().optional(), universe: z.string().optional(), sort: z.enum(['popular', 'new', 'featured']).default('popular') }).parse(req.query);
  const p = []; const where = [`sh.status = 'active'`, `EXISTS (SELECT 1 FROM subscriptions sb WHERE sb.shop_id = sh.id AND sb.status = 'active' AND sb.ends_at > now())`];
  // Boutiques À La Une : boutiques ayant une campagne en cours
  if (q.sort === 'featured') where.push(`EXISTS (SELECT 1 FROM promotions pr WHERE pr.shop_id = sh.id AND pr.kind = 'campaign' AND pr.status = 'active' AND pr.ends_at > now())`);
  if (q.quarter) { p.push(q.quarter); where.push(`sh.quarter = $${p.length}`); }
  if (q.universe) { p.push(q.universe); where.push(`c.slug = $${p.length}`); }
  const items = await db.many(
    `SELECT sh.id, sh.slug, sh.name, sh.description, sh.quarter, sh.banner, sh.created_at, c.name universe,
       ${sellerRating} rating,
       (SELECT count(*)::int FROM listings l WHERE l.shop_id = sh.id AND l.status = 'active') listings
     FROM shops sh LEFT JOIN categories c ON c.id = sh.universe WHERE ${where.join(' AND ')}
     ORDER BY ${q.sort === 'new' ? 'sh.created_at DESC' : 'listings DESC, sh.created_at'} LIMIT 60`, p);
  res.json({ items });
});

r.get('/shops/:slug', async (req, res) => {
  const shop = await db.one(
    `SELECT sh.id, sh.slug, sh.name, sh.description, sh.quarter, sh.city, sh.banner, sh.created_at, sh.owner_id, sh.status,
       u.first_name owner_first_name, (u.verification_status = 'verified') owner_verified, c.name universe, ${sellerRating} rating,
       (SELECT count(*)::int FROM orders o WHERE o.seller_id = sh.owner_id AND o.status = 'completed') sales
     FROM shops sh JOIN users u ON u.id = sh.owner_id LEFT JOIN categories c ON c.id = sh.universe WHERE sh.slug = $1`, [req.params.slug]);
  if (!shop || shop.status !== 'active') throw notFound('Boutique introuvable.');
  const reviews = await db.many(
    `SELECT r.rating, r.tags, r.comment, r.created_at, u.first_name author FROM reviews r JOIN users u ON u.id = r.author_id
     WHERE r.target_id = $1 ORDER BY r.created_at DESC LIMIT 10`, [shop.owner_id]);
  res.json({ shop, reviews });
});

// ---------- Publicité : bannières payantes (P25), toujours signalées comme telles ----------
r.get('/ads', async (req, res) => {
  const q = z.object({ placement: z.enum(['home', 'category']).default('home'), category: z.string().optional(), quarter: z.string().optional() }).parse(req.query);
  const p = [q.placement]; let extra = '';
  if (q.placement === 'category' && q.category) { p.push(q.category); extra += ` AND (pr.category_id IS NULL OR pr.category_id = (SELECT id FROM categories WHERE slug = $${p.length}))`; }
  if (q.quarter) { p.push(q.quarter); extra += ` AND (pr.quarter IS NULL OR pr.quarter = $${p.length})`; }
  const ads = await db.many(
    `SELECT pr.id, pr.title, pr.image_url, sh.name shop_name, sh.slug shop_slug FROM promotions pr JOIN shops sh ON sh.id = pr.shop_id
     WHERE pr.kind = 'ad' AND pr.status = 'active' AND pr.ends_at > now() AND pr.placement = $1 ${extra} ORDER BY random() LIMIT 3`, p);
  if (ads.length) db.query('UPDATE promotions SET impressions = impressions + 1 WHERE id = ANY($1)', [ads.map((a) => a.id)]).catch(() => {});
  res.json({ items: ads });
});
r.post('/ads/:id/click', async (req, res) => {
  const a = await db.one(`UPDATE promotions SET clicks = clicks + 1 WHERE id = $1 AND kind = 'ad' RETURNING (SELECT slug FROM shops WHERE id = shop_id) slug`, [req.params.id]);
  res.json({ to: a ? `/b/${a.slug}` : '/' });
});

export default r;
