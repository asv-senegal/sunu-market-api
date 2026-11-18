import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { bad } from '../lib/http.js';
import { requireAuth, publicUser } from '../lib/auth.js';
import { kycUpload, removeFile } from '../lib/upload.js';
import { audit } from '../lib/audit.js';
import { currentSubscription } from '../lib/shop.js';
import { optimize } from '../lib/images.js';
import { balance } from '../lib/credits.js';
import { triggerKycPrecheck } from '../lib/smia.js';
import { NOTIF_GROUPS } from '../lib/audit.js';

const r = Router();
r.use(requireAuth);

r.get('/', async (req, res) => {
  const shop = await db.one('SELECT id, slug, name FROM shops WHERE owner_id = $1', [req.user.id]);
  const sub = shop && await currentSubscription(db, shop.id);
  const c = await db.one(
    `SELECT (SELECT count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL)::int notifications,
            (SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
              WHERE (c.buyer_id = $1 OR c.seller_id = $1) AND m.sender_id IS DISTINCT FROM $1 AND m.read_at IS NULL)::int messages`,
    [req.user.id]);
  res.json({ user: publicUser(req.user), shop: shop && { ...shop, subscription: sub && { kind: sub.kind, endsAt: sub.ends_at } }, unread: c,
    credits: await balance(req.user.id) });
});

r.patch('/', async (req, res) => {
  const b = z.object({ quarter: z.string().trim().max(80).optional(), city: z.string().trim().max(60).optional() }).parse(req.body);
  const u = await db.one('UPDATE users SET quarter = coalesce($2, quarter), city = coalesce($3, city), updated_at = now() WHERE id = $1 RETURNING *',
    [req.user.id, b.quarter ?? null, b.city ?? null]);
  res.json({ user: publicUser(u) });
});

// Étape 2 : pièce d'identité + selfie (obligatoire)
r.get('/verification', async (req, res) => {
  const v = await db.one('SELECT status, doc_type, reason, submitted_at, decided_at FROM verifications WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT 1', [req.user.id]);
  res.json({ status: req.user.verification_status, last: v });
});

r.post('/verification', kycUpload.fields([{ name: 'document', maxCount: 1 }, { name: 'selfie', maxCount: 1 }]), async (req, res) => {
  const doc = req.files?.document?.[0]; const selfie = req.files?.selfie?.[0];
  const clean = () => { removeFile(doc?.path); removeFile(selfie?.path); };
  try {
    const { docType } = z.object({ docType: z.enum(['cni', 'passport', 'residence']) }).parse(req.body);
    if (!doc || !selfie) throw bad('La pièce d’identité et le selfie sont tous deux obligatoires.', 'kyc_missing');
    if (['pending', 'verified'].includes(req.user.verification_status)) throw bad('Un dossier est déjà en cours ou validé.', 'kyc_exists');
    // Recadrage et suppression des métadonnées (position GPS, appareil) avant stockage
    await optimize(doc, { max: 1600, quality: 82, format: 'jpeg' });
    await optimize(selfie, { max: 1200, quality: 82, format: 'jpeg' });
    const vid = await db.tx(async (t) => {
      const v = await t.one('INSERT INTO verifications (user_id, doc_type, doc_file, selfie_file) VALUES ($1,$2,$3,$4) RETURNING id', [req.user.id, docType, doc.path, selfie.path]);
      await t.query(`UPDATE users SET verification_status = 'pending', updated_at = now() WHERE id = $1`, [req.user.id]);
      await audit(req.user.id, 'verification.submitted', `user:${req.user.id}`, { docType }, t);
      return v.id;
    });
    triggerKycPrecheck(vid);
    res.status(201).json({ status: 'pending' });
  } catch (e) { clean(); throw e; }
});

r.get('/notifications', async (req, res) => {
  res.json({ items: await db.many('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]) });
});
r.post('/notifications/read', async (req, res) => {
  await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({ ok: true });
});

// Préférences de notification par groupe et par canal (P18)
r.get('/notification-prefs', async (req, res) => {
  const p = (await db.one('SELECT prefs FROM notification_prefs WHERE user_id = $1', [req.user.id]))?.prefs || {};
  res.json({ groups: Object.fromEntries(Object.entries(NOTIF_GROUPS).map(([k, g]) => [k, { label: g.label, ...g.def, ...(p[k] || {}) }])) });
});
r.put('/notification-prefs', async (req, res) => {
  const ch = z.object({ app: z.boolean(), sms: z.boolean(), whatsapp: z.boolean() });
  const b = z.record(z.enum(Object.keys(NOTIF_GROUPS)), ch).parse(req.body);
  await db.query(`INSERT INTO notification_prefs (user_id, prefs) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET prefs = $2, updated_at = now()`, [req.user.id, b]);
  res.json({ ok: true });
});

r.get('/favorites', async (req, res) => {
  res.json({ items: await db.many(
    `SELECT l.id, l.title, l.price_fcfa, (SELECT url FROM listing_photos p WHERE p.listing_id = l.id ORDER BY position LIMIT 1) photo
     FROM favorites f JOIN listings l ON l.id = f.listing_id WHERE f.user_id = $1 ORDER BY f.created_at DESC`, [req.user.id]) });
});
r.post('/favorites/:listingId', async (req, res) => {
  const on = await db.one('DELETE FROM favorites WHERE user_id = $1 AND listing_id = $2 RETURNING 1', [req.user.id, req.params.listingId]);
  if (!on) await db.query('INSERT INTO favorites (user_id, listing_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, req.params.listingId]);
  res.json({ favorite: !on });
});

export default r;
