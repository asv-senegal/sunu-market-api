// Espace « Ma Boutique » : création de boutique, essai, abonnement, tableau de bord
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { bad, notFound } from '../lib/http.js';
import { requireVerified } from '../lib/auth.js';
import { slugify } from '../lib/text.js';
import { audit, notify } from '../lib/audit.js';
import { currentSubscription } from '../lib/shop.js';
import { createPayment, liveProviders } from '../lib/payments.js';
import { move, pricing } from '../lib/credits.js';
import { listingUpload, removeFile } from '../lib/upload.js';
import { optimize } from '../lib/images.js';
import { forbidden, HttpError } from '../lib/http.js';

const r = Router();
r.use(['/shop', '/subscription', '/promotions'], requireVerified);

import { setting } from '../lib/settings.js';
import { idempotent } from '../lib/idempotency.js';

// Créer sa boutique : démarre l'essai gratuit (14 jours, paramétrable)
r.post('/shop', async (req, res) => {
  const b = z.object({
    name: z.string().trim().min(3).max(60), description: z.string().trim().max(600).optional(),
    quarter: z.string().trim().max(80).optional(), universe: z.coerce.number().int().optional(),
  }).parse(req.body);
  if (await db.one('SELECT 1 FROM shops WHERE owner_id = $1', [req.user.id])) throw bad('Vous avez déjà une boutique.', 'shop_exists');
  let slug = slugify(b.name) || 'boutique';
  if (await db.one('SELECT 1 FROM shops WHERE slug = $1', [slug])) slug += '-' + Math.random().toString(36).slice(2, 6);
  const trialDays = Number(await setting('trial_days')) || 14;
  const shop = await db.tx(async (t) => {
    const s = await t.one(`INSERT INTO shops (owner_id, slug, name, description, quarter, universe) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, slug, b.name, b.description || null, b.quarter || req.user.quarter, b.universe || null]);
    await t.query(`INSERT INTO subscriptions (shop_id, kind, amount_fcfa, starts_at, ends_at) VALUES ($1,'trial',0,now(), now() + make_interval(days => $2))`, [s.id, trialDays]);
    const pr = await pricing();
    if (pr.trialCredits > 0) await move(t, req.user.id, pr.trialCredits, 'grant_trial', { note: 'Crédits SM-IA offerts pendant l’essai' });
    await audit(req.user.id, 'shop.created', `shop:${s.id}`, { trialDays, trialCredits: pr.trialCredits }, t);
    await notify(req.user.id, 'trial', 'Votre Essai Gratuit Commence', `Vous avez ${trialDays} jours pour essayer votre boutique.`, '/ma-boutique/abonnement', t);
    return s;
  });
  res.status(201).json({ shop });
});

async function myShop(userId) {
  const s = await db.one('SELECT * FROM shops WHERE owner_id = $1', [userId]);
  if (!s) throw notFound('Vous n’avez pas encore de boutique.');
  return s;
}

// Tableau de bord (P20) : période 7 jours, 30 jours ou 12 mois, comparée à la période précédente
r.get('/shop', async (req, res) => {
  const shop = await myShop(req.user.id);
  const sub = await currentSubscription(db, shop.id);
  const range = ['7', '30', '365'].includes(String(req.query.range)) ? Number(req.query.range) : 30;
  const iv = `${range} days`;
  const k = await db.one(
    `SELECT
       (SELECT coalesce(sum(total_fcfa),0)::int FROM orders WHERE seller_id = $1 AND status = 'completed' AND updated_at > now() - $3::interval) sales,
       (SELECT coalesce(sum(total_fcfa),0)::int FROM orders WHERE seller_id = $1 AND status = 'completed' AND updated_at BETWEEN now() - 2 * $3::interval AND now() - $3::interval) sales_prev,
       (SELECT count(*)::int FROM orders WHERE seller_id = $1 AND created_at > now() - $3::interval) orders,
       (SELECT count(*)::int FROM orders WHERE seller_id = $1 AND created_at BETWEEN now() - 2 * $3::interval AND now() - $3::interval) orders_prev,
       (SELECT count(*)::int FROM orders WHERE seller_id = $1 AND status IN ('new','accepted','scheduled')) open_orders,
       (SELECT count(*)::int FROM orders WHERE seller_id = $1 AND status = 'new') new_orders,
       (SELECT count(*)::int FROM orders WHERE seller_id = $1 AND status = 'scheduled' AND (meeting_at AT TIME ZONE 'Africa/Dakar')::date = (now() AT TIME ZONE 'Africa/Dakar')::date) meetings_today,
       (SELECT coalesce(sum(views),0)::int FROM listings WHERE shop_id = $2) views,
       (SELECT count(*)::int FROM listings WHERE shop_id = $2 AND status = 'active') active_listings,
       (SELECT count(*)::int FROM listings WHERE shop_id = $2 AND status = 'active' AND stock <= 3) low_stock,
       (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.seller_id = $1 AND m.sender_id IS DISTINCT FROM $1 AND m.created_at > now() - $3::interval) messages,
       (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.seller_id = $1 AND m.kind = 'ai' AND m.created_at > now() - $3::interval) messages_ai,
       (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.seller_id = $1 AND m.sender_id IS DISTINCT FROM $1 AND m.read_at IS NULL) unread_messages,
       (SELECT count(*)::int FROM ai_actions WHERE user_id = $1 AND source = 'chatbot' AND order_id IS NOT NULL AND kind LIKE '%accept%' AND status IN ('done','approved') AND created_at > now() - interval '7 days') ai_orders_week,
       (SELECT round(avg(rating)::numeric, 1)::float FROM reviews WHERE target_id = $1) rating,
       (SELECT count(*)::int FROM reviews WHERE target_id = $1) reviews`,
    [req.user.id, shop.id, iv]);
  // Série : par jour (7 ou 30 jours) ou par mois (12 mois), avec la période précédente pour la courbe en pointillés
  const monthly = range === 365;
  const step = monthly ? '1 month' : '1 day';
  const trunc = monthly ? 'month' : 'day';
  const n = monthly ? 11 : range - 1;
  const series = await db.many(
    `WITH d AS (SELECT generate_series(date_trunc('${trunc}', now() AT TIME ZONE 'Africa/Dakar') - ($3 || ' ${monthly ? 'months' : 'days'}')::interval,
                                       date_trunc('${trunc}', now() AT TIME ZONE 'Africa/Dakar'), interval '${step}') AS d)
     SELECT to_char(d, 'YYYY-MM-DD') AS day,
       (SELECT coalesce(sum(total_fcfa),0)::int FROM orders o WHERE o.seller_id = $1 AND o.status = 'completed'
          AND date_trunc('${trunc}', o.updated_at AT TIME ZONE 'Africa/Dakar') = d) sales,
       (SELECT coalesce(sum(total_fcfa),0)::int FROM orders o WHERE o.seller_id = $1 AND o.status = 'completed'
          AND date_trunc('${trunc}', o.updated_at AT TIME ZONE 'Africa/Dakar') = d - $2::interval) prev,
       (SELECT count(*)::int FROM orders o WHERE o.seller_id = $1 AND date_trunc('${trunc}', o.created_at AT TIME ZONE 'Africa/Dakar') = d) orders
     FROM d ORDER BY d`, [req.user.id, monthly ? '12 months' : iv, String(n)]);
  const top = await db.many(
    `SELECT l.id, l.title, l.price_fcfa, l.views, (SELECT count(*)::int FROM orders o WHERE o.listing_id = l.id AND o.status = 'completed') sold,
       (SELECT url FROM listing_photos p WHERE p.listing_id = l.id ORDER BY position LIMIT 1) photo
     FROM listings l WHERE l.shop_id = $1 AND l.status <> 'removed' ORDER BY sold DESC, l.views DESC LIMIT 5`, [shop.id]);
  const recent = await db.many(
    `SELECT o.id, o.ref, o.title_snapshot, o.quantity, o.total_fcfa, o.pay_method, o.status, o.meeting_at, o.created_at,
       u.first_name, u.last_name FROM orders o JOIN users u ON u.id = o.buyer_id WHERE o.seller_id = $1 ORDER BY o.created_at DESC LIMIT 5`, [req.user.id]);
  const credits = (await db.one('SELECT balance FROM credit_wallets WHERE user_id = $1', [req.user.id]))?.balance ?? 0;
  const ai = await db.one('SELECT chatbot_enabled FROM ai_settings WHERE user_id = $1', [req.user.id]);
  res.json({ shop, subscription: sub, range, stats: { ...k, sales_30d: k.sales }, top, series, recent, credits, aiOrders: !!ai?.chatbot_enabled });
});

// Avis Clients : notes reçues par le commerçant (P16 côté vendeur)
r.get('/reviews', async (req, res) => {
  const items = await db.many(
    `SELECT r.id, r.rating, r.tags, r.comment, r.created_at, o.ref, o.title_snapshot, u.first_name, u.last_name,
       (SELECT r2.rating FROM reviews r2 WHERE r2.order_id = r.order_id AND r2.author_id = $1) my_rating
     FROM reviews r JOIN orders o ON o.id = r.order_id JOIN users u ON u.id = r.author_id
     WHERE r.target_id = $1 ORDER BY r.created_at DESC LIMIT 200`, [req.user.id]);
  const dist = [5, 4, 3, 2, 1].map((n) => ({ stars: n, count: items.filter((x) => x.rating === n).length }));
  const tags = {};
  for (const x of items) for (const t of x.tags || []) tags[t] = (tags[t] || 0) + 1;
  const toReview = await db.many(
    `SELECT o.id, o.ref, o.title_snapshot, u.first_name, u.last_name, o.updated_at FROM orders o JOIN users u ON u.id = o.buyer_id
     WHERE o.seller_id = $1 AND o.status = 'completed' AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.order_id = o.id AND r.author_id = $1)
     ORDER BY o.updated_at DESC LIMIT 20`, [req.user.id]);
  res.json({ items, average: items.length ? Math.round(items.reduce((a, x) => a + x.rating, 0) / items.length * 10) / 10 : null,
    distribution: dist, tags: Object.entries(tags).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count })), toReview });
});

r.patch('/shop', async (req, res) => {
  const shop = await myShop(req.user.id);
  const b = z.object({ name: z.string().trim().min(3).max(60).optional(), description: z.string().trim().max(600).optional(),
    quarter: z.string().trim().max(80).optional(), universe: z.coerce.number().int().optional(),
    hours: z.string().trim().max(120).optional(), meetingPlace: z.string().trim().max(120).optional(),
    deliveryModes: z.array(z.enum(['hand', 'delivery', 'pickup'])).min(1, 'Choisissez au moins un mode de remise.').optional(),
    payMethods: z.array(z.enum(['wave', 'orange_money', 'cash'])).min(1, 'Choisissez au moins un moyen de paiement.').optional(),
    vacation: z.boolean().optional() }).parse(req.body);
  const s = await db.one(
    `UPDATE shops SET name = coalesce($2,name), description = coalesce($3,description), quarter = coalesce($4,quarter), universe = coalesce($5,universe),
       hours = coalesce($6,hours), meeting_place = coalesce($7,meeting_place), delivery_modes = coalesce($8,delivery_modes), pay_methods = coalesce($9,pay_methods),
       vacation = coalesce($10,vacation)
     WHERE id = $1 RETURNING *`, [shop.id, b.name ?? null, b.description ?? null, b.quarter ?? null, b.universe ?? null,
       b.hours ?? null, b.meetingPlace ?? null, b.deliveryModes ?? null, b.payMethods ?? null, b.vacation ?? null]);
  await audit(req.user.id, 'shop.settings', `shop:${shop.id}`, b);
  res.json({ shop: s });
});

r.get('/shop/listings', async (req, res) => {
  const shop = await myShop(req.user.id);
  res.json({ items: await db.many(
    `SELECT l.id, l.title, l.price_fcfa, l.stock, l.status, l.views, l.created_at, (l.featured_until > now()) featured, l.featured_until,
       s.name sub, c.name category, (SELECT url FROM listing_photos p WHERE p.listing_id = l.id ORDER BY position LIMIT 1) photo
     FROM listings l JOIN subcategories s ON s.id = l.subcategory_id JOIN categories c ON c.id = s.category_id
     WHERE l.shop_id = $1 AND l.status <> 'removed' ORDER BY l.created_at DESC`, [shop.id]),
    pendingSuggestions: await db.many(`SELECT id, listing_id, summary, payload, created_at FROM ai_actions WHERE user_id = $1 AND kind = 'listing_update' AND status = 'pending' ORDER BY created_at DESC`, [req.user.id]) });
});

// Abonnement annuel : paiement Wave ou Orange Money (API si configurée, sinon référence déclarée puis confirmée par l'équipe)
r.get('/subscription', async (req, res) => {
  const shop = await myShop(req.user.id);
  res.json({
    price: Number(await setting('subscription_annual_fcfa')),
    credits: (await pricing()).subscriptionCredits,
    current: await currentSubscription(db, shop.id),
    live: liveProviders(),
    history: await db.many('SELECT id, kind, amount_fcfa, starts_at, ends_at, status, pay_method, pay_ref, created_at FROM subscriptions WHERE shop_id = $1 ORDER BY created_at DESC', [shop.id]),
    payments: await db.many(`SELECT ref, total_fcfa, provider, provider_ref, status, created_at FROM payments WHERE shop_id = $1 AND purpose = 'subscription' ORDER BY created_at DESC LIMIT 10`, [shop.id]),
  });
});

const payBody = z.object({ payMethod: z.enum(['wave', 'orange_money']), payRef: z.string().trim().min(4).max(60).optional() });
const requireRef = (b) => { const live = liveProviders()[b.payMethod]; if (!live && !b.payRef) throw bad('Indiquez la référence de la transaction reçue par SMS.', 'pay_ref'); };

r.post('/subscription', idempotent('subscription'), async (req, res) => {
  const shop = await myShop(req.user.id);
  const b = payBody.parse(req.body); requireRef(b);
  if (await db.one(`SELECT 1 FROM payments WHERE shop_id = $1 AND purpose = 'subscription' AND status = 'pending' AND provider = 'manual'`, [shop.id])) throw bad('Un paiement est déjà en attente de confirmation.', 'pending_payment');
  const price = Number(await setting('subscription_annual_fcfa'));
  const p = await createPayment({ userId: req.user.id, shopId: shop.id, purpose: 'subscription', amount: price, provider: b.payMethod, payRef: b.payRef });
  res.status(201).json({ payment: p });
});

// ---------- Visibilité : mise en avant, campagnes, publicité (P25) ----------
const PRICE_KEY = { featured: 'featured_price_per_day_fcfa', campaign: 'campaign_price_per_day_fcfa', ad: 'ad_price_per_day_fcfa' };
r.get('/promotions', async (req, res) => {
  const shop = await myShop(req.user.id);
  const s = await Promise.all(Object.values(PRICE_KEY).map((k) => setting(k)));
  res.json({
    prices: { featured: s[0], campaign: s[1], ad: s[2] }, live: liveProviders(),
    items: await db.many(
      `SELECT pr.*, l.title listing_title, p.ref payment_ref, p.status payment_status, p.total_fcfa FROM promotions pr
       LEFT JOIN listings l ON l.id = pr.listing_id LEFT JOIN payments p ON p.id = pr.payment_id WHERE pr.shop_id = $1 ORDER BY pr.created_at DESC`, [shop.id]),
  });
});

r.post('/promotions', listingUpload.single('image'), idempotent('promotion'), async (req, res) => {
  const file = req.file;
  try {
    const shop = await myShop(req.user.id);
    const b = z.object({
      kind: z.enum(['featured', 'campaign', 'ad']), listingId: z.uuid().optional(),
      placement: z.enum(['search_top', 'home', 'category']).default('search_top'), categoryId: z.coerce.number().int().optional(),
      quarter: z.string().trim().max(60).optional(), days: z.coerce.number().int().min(1).max(60),
      promoPrice: z.coerce.number().int().min(0).optional(), title: z.string().trim().max(80).optional(),
      payMethod: z.enum(['wave', 'orange_money']), payRef: z.string().trim().min(4).max(60).optional(),
    }).parse(req.body);
    requireRef(b);
    const perDay = await setting(PRICE_KEY[b.kind]);
    if (perDay == null) throw new HttpError(409, 'Le tarif de ce service n’est pas encore fixé par Sunu-Market.', 'price_unset');
    if (b.kind === 'campaign' && (b.days < 3 || b.days > 14)) throw bad('Une campagne dure de 3 à 14 jours.', 'days');
    let listing = null;
    if (b.kind !== 'ad') {
      listing = b.listingId && await db.one(`SELECT id, price_fcfa FROM listings WHERE id = $1 AND shop_id = $2 AND status = 'active'`, [b.listingId, shop.id]);
      if (!listing) throw bad('Choisissez une de vos annonces en ligne.', 'listing');
      if (b.kind === 'campaign' && !(b.promoPrice < listing.price_fcfa)) throw bad('Le prix promotionnel doit être inférieur au prix affiché.', 'promo_price');
    } else {
      if (!file) throw bad('Ajoutez l’image de la bannière.', 'image');
      if (!b.title) throw bad('Ajoutez un titre à la bannière.', 'title');
      await optimize(file, { max: 1600, quality: 80 });
    }
    const amount = Number(perDay) * b.days;
    const promo = await db.one(
      `INSERT INTO promotions (shop_id, kind, listing_id, placement, category_id, quarter, promo_price_fcfa, title, image_url, days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [shop.id, b.kind, listing?.id || null, b.kind === 'ad' ? (b.placement === 'search_top' ? 'home' : b.placement) : b.placement, b.categoryId || null,
        b.quarter || null, b.kind === 'campaign' ? b.promoPrice : null, b.title || null, file ? `/files/listings/${file.filename}` : null, b.days]);
    const p = await createPayment({ userId: req.user.id, shopId: shop.id, purpose: b.kind, purposeId: promo.id, amount, provider: b.payMethod, payRef: b.payRef });
    await db.query('UPDATE promotions SET payment_id = $2 WHERE id = $1', [promo.id, p.id]);
    res.status(201).json({ promotion: promo, payment: p });
  } catch (e) { if (file) removeFile(file.path); throw e; }
});

// Export des commandes reçues (CSV, séparateur point-virgule pour Excel en français)
r.get('/shop/orders.csv', async (req, res) => {
  const rows = await db.many(
    `SELECT o.ref, to_char(o.created_at AT TIME ZONE 'Africa/Dakar', 'DD/MM/YYYY HH24:MI') date, o.title_snapshot, o.quantity, o.total_fcfa, o.pay_method, o.delivery_mode, o.status,
       u.first_name || ' ' || left(u.last_name,1) || '.' acheteur FROM orders o JOIN users u ON u.id = o.buyer_id WHERE o.seller_id = $1 ORDER BY o.created_at DESC`, [req.user.id]);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['Référence;Date;Article;Quantité;Total FCFA;Paiement;Remise;État;Acheteur', ...rows.map((r) => [r.ref, r.date, r.title_snapshot, r.quantity, r.total_fcfa, r.pay_method, r.delivery_mode, r.status, r.acheteur].map(esc).join(';'))].join('\r\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="commandes-sunu-market.csv"' }).send('\ufeff' + csv);
});

export default r;
