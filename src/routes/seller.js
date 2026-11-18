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

r.get('/shop', async (req, res) => {
  const shop = await myShop(req.user.id);
  const sub = await currentSubscription(db, shop.id);
  const stats = await db.one(
    `SELECT
       (SELECT coalesce(sum(total_fcfa),0)::int FROM orders WHERE seller_id = $1 AND status = 'completed' AND updated_at > now() - interval '30 days') sales_30d,
       (SELECT count(*)::int FROM orders WHERE seller_id = $1 AND status IN ('new','accepted','scheduled')) open_orders,
       (SELECT count(*)::int FROM orders WHERE seller_id = $1 AND status = 'new') new_orders,
       (SELECT coalesce(sum(views),0)::int FROM listings WHERE shop_id = $2) views,
       (SELECT count(*)::int FROM listings WHERE shop_id = $2 AND status = 'active') active_listings,
       (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.seller_id = $1 AND m.sender_id IS DISTINCT FROM $1 AND m.read_at IS NULL) unread_messages`,
    [req.user.id, shop.id]);
  const top = await db.many(
    `SELECT l.id, l.title, l.price_fcfa, l.views, (SELECT count(*)::int FROM orders o WHERE o.listing_id = l.id AND o.status = 'completed') sold,
       (SELECT url FROM listing_photos p WHERE p.listing_id = l.id ORDER BY position LIMIT 1) photo
     FROM listings l WHERE l.shop_id = $1 AND l.status <> 'removed' ORDER BY sold DESC, l.views DESC LIMIT 5`, [shop.id]);
  const series = await db.many(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day,
       (SELECT coalesce(sum(total_fcfa),0)::int FROM orders o WHERE o.seller_id = $1 AND o.status = 'completed' AND (o.updated_at AT TIME ZONE 'Africa/Dakar')::date = d::date) sales,
       (SELECT count(*)::int FROM orders o WHERE o.seller_id = $1 AND (o.created_at AT TIME ZONE 'Africa/Dakar')::date = d::date) orders
     FROM generate_series((now() AT TIME ZONE 'Africa/Dakar')::date - 13, (now() AT TIME ZONE 'Africa/Dakar')::date, interval '1 day') d`, [req.user.id]);
  const credits = (await db.one('SELECT balance FROM credit_wallets WHERE user_id = $1', [req.user.id]))?.balance ?? 0;
  res.json({ shop, subscription: sub, stats, top, series, credits });
});

r.patch('/shop', async (req, res) => {
  const shop = await myShop(req.user.id);
  const b = z.object({ name: z.string().trim().min(3).max(60).optional(), description: z.string().trim().max(600).optional(),
    quarter: z.string().trim().max(80).optional(), universe: z.coerce.number().int().optional() }).parse(req.body);
  const s = await db.one(
    `UPDATE shops SET name = coalesce($2,name), description = coalesce($3,description), quarter = coalesce($4,quarter), universe = coalesce($5,universe)
     WHERE id = $1 RETURNING *`, [shop.id, b.name ?? null, b.description ?? null, b.quarter ?? null, b.universe ?? null]);
  res.json({ shop: s });
});

r.get('/shop/listings', async (req, res) => {
  const shop = await myShop(req.user.id);
  res.json({ items: await db.many(
    `SELECT l.id, l.title, l.price_fcfa, l.stock, l.status, l.views, l.created_at, (l.featured_until > now()) featured,
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

r.post('/subscription', async (req, res) => {
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

r.post('/promotions', listingUpload.single('image'), async (req, res) => {
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
