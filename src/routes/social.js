// SM-Chat, commandes, avis, signalements.
// Les échanges se font dans l'application ; le paiement se conclut directement entre les deux membres.
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { bad, forbidden, notFound } from '../lib/http.js';
import { requireVerified } from '../lib/auth.js';
import { audit, notify } from '../lib/audit.js';
import { VISIBLE, PROMO } from '../lib/shop.js';
import { triggerChatbot } from '../lib/smia.js';
import { listingUpload, kycUpload, removeFile } from '../lib/upload.js';
import { optimize } from '../lib/images.js';
import { idempotent } from '../lib/idempotency.js';

const r = Router();
r.use(['/conversations', '/orders', '/reports', '/report-evidence'], requireVerified);
const fcfa = (n) => n.toLocaleString('fr-FR').replace(/ |\s/g, ' ') + ' FCFA';
const PAY = { wave: 'Wave', orange_money: 'Orange Money', cash: 'espèces' };

async function visibleListing(t, id) {
  const l = await t.one(
    `SELECT l.*, sh.owner_id, coalesce(${PROMO}, l.price_fcfa) unit_price FROM listings l JOIN shops sh ON sh.id = l.shop_id WHERE l.id = $1 AND ${VISIBLE}`, [id]);
  if (!l) throw notFound('Annonce introuvable ou indisponible.');
  return l;
}

async function getOrCreateConversation(t, listing, buyerId) {
  if (listing.owner_id === buyerId) throw bad('Vous ne pouvez pas écrire à votre propre boutique.', 'self');
  return (await t.one('SELECT * FROM conversations WHERE listing_id = $1 AND buyer_id = $2', [listing.id, buyerId]))
    || t.one('INSERT INTO conversations (listing_id, buyer_id, seller_id) VALUES ($1,$2,$3) RETURNING *', [listing.id, buyerId, listing.owner_id]);
}

async function postMessage(t, convId, senderId, body, kind = 'text', orderId = null) {
  const m = await t.one('INSERT INTO messages (conversation_id, sender_id, kind, body, order_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [convId, senderId, kind, body, orderId]);
  await t.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [convId]);
  return m;
}

async function myConversation(id, userId) {
  if (!z.uuid().safeParse(id).success) throw notFound('Conversation introuvable.');
  const c = await db.one('SELECT * FROM conversations WHERE id = $1 AND (buyer_id = $2 OR seller_id = $2)', [id, userId]);
  if (!c) throw notFound('Conversation introuvable.');
  return c;
}

// ---------- SM-Chat ----------
r.get('/conversations', async (req, res) => {
  res.json({ items: await db.many(
    `SELECT c.id, c.last_message_at, (c.seller_id = $1) as i_am_seller,
       l.id listing_id, l.title listing_title, l.price_fcfa,
       (SELECT url FROM listing_photos p WHERE p.listing_id = l.id ORDER BY position LIMIT 1) photo,
       CASE WHEN c.seller_id = $1 THEN bu.first_name || ' ' || left(bu.last_name, 1) || '.' ELSE sh.name END other_name,
       (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) last_body,
       (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.sender_id IS DISTINCT FROM $1 AND m.read_at IS NULL) unread
     FROM conversations c JOIN users bu ON bu.id = c.buyer_id
     LEFT JOIN listings l ON l.id = c.listing_id LEFT JOIN shops sh ON sh.owner_id = c.seller_id
     WHERE c.buyer_id = $1 OR c.seller_id = $1 ORDER BY c.last_message_at DESC LIMIT 100`, [req.user.id]) });
});

r.post('/conversations', async (req, res) => {
  const b = z.object({ listingId: z.uuid(), body: z.string().trim().min(1).max(2000) }).parse(req.body);
  const conv = await db.tx(async (t) => {
    const l = await visibleListing(t, b.listingId);
    const c = await getOrCreateConversation(t, l, req.user.id);
    await postMessage(t, c.id, req.user.id, b.body);
    await notify(l.owner_id, 'message', 'Nouveau Message SM-Chat', b.body.slice(0, 120), `/messages/${c.id}`, t);
    return c;
  });
  triggerChatbot(conv.id);
  res.status(201).json({ conversation: conv });
});

r.get('/conversations/:id', async (req, res) => {
  const c = await myConversation(req.params.id, req.user.id);
  const after = req.query.after ? new Date(String(req.query.after)) : null;
  const messages = await db.many(
    `SELECT id, sender_id, kind, body, order_id, image_url, created_at, read_at FROM messages WHERE conversation_id = $1 ${after ? 'AND created_at > $2' : ''}
     ORDER BY created_at ASC LIMIT 500`, after ? [c.id, after] : [c.id]);
  await db.query('UPDATE messages SET read_at = now() WHERE conversation_id = $1 AND sender_id IS DISTINCT FROM $2 AND read_at IS NULL', [c.id, req.user.id]);
  const meta = await db.one(
    `SELECT l.id listing_id, l.title, l.price_fcfa, (SELECT url FROM listing_photos p WHERE p.listing_id = l.id ORDER BY position LIMIT 1) photo,
       sh.name shop_name, sh.slug shop_slug, bu.first_name || ' ' || left(bu.last_name,1) || '.' buyer_name
     FROM conversations c JOIN users bu ON bu.id = c.buyer_id LEFT JOIN listings l ON l.id = c.listing_id LEFT JOIN shops sh ON sh.owner_id = c.seller_id
     WHERE c.id = $1`, [c.id]);
  const orders = await db.many('SELECT id, ref, status, total_fcfa, pay_method, delivery_mode, meeting_place, meeting_at FROM orders WHERE conversation_id = $1 ORDER BY created_at DESC', [c.id]);
  const smia = await db.one(`SELECT (s.enabled AND s.chatbot_enabled) AS active FROM ai_settings s WHERE s.user_id = $1`, [c.seller_id]);
  res.json({ conversation: { ...c, ...meta, iAmSeller: c.seller_id === req.user.id, smiaActive: !!smia?.active }, messages, orders });
});

r.post('/conversations/:id/messages', idempotent('message'), async (req, res) => {
  const c = await myConversation(req.params.id, req.user.id);
  const { body } = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body);
  const m = await db.tx(async (t) => {
    const m = await postMessage(t, c.id, req.user.id, body);
    const other = c.buyer_id === req.user.id ? c.seller_id : c.buyer_id;
    await notify(other, 'message', 'Nouveau Message SM-Chat', body.slice(0, 120), `/messages/${c.id}`, t);
    return m;
  });
  if (c.buyer_id === req.user.id) triggerChatbot(c.id);
  res.status(201).json({ message: m });
});

// Photo dans SM-Chat (compressée, sans métadonnées)
r.post('/conversations/:id/images', listingUpload.single('image'), async (req, res) => {
  const f = req.file;
  try {
    const c = await myConversation(req.params.id, req.user.id);
    if (!f) throw bad('Ajoutez une image.', 'image');
    await optimize(f, { max: 1280, quality: 75 });
    const m = await db.tx(async (t) => {
      const m = await postMessage(t, c.id, req.user.id, 'Photo', 'image');
      await t.query('UPDATE messages SET image_url = $2 WHERE id = $1', [m.id, `/files/listings/${f.filename}`]);
      const other = c.buyer_id === req.user.id ? c.seller_id : c.buyer_id;
      await notify(other, 'message', 'Nouvelle Photo Dans SM-Chat', 'Une photo vous a été envoyée.', `/messages/${c.id}`, t);
      return m;
    });
    res.status(201).json({ message: m });
  } catch (e) { if (f) removeFile(f.path); throw e; }
});

// ---------- Commandes ----------
r.post('/orders', idempotent('order'), async (req, res) => {
  const b = z.object({
    listingId: z.uuid(), quantity: z.coerce.number().int().min(1).max(99).default(1),
    deliveryMode: z.enum(['hand', 'delivery', 'pickup']), payMethod: z.enum(['wave', 'orange_money', 'cash']),
    note: z.string().trim().max(500).optional(),
  }).parse(req.body);
  const order = await db.tx(async (t) => {
    const l = await visibleListing(t, b.listingId);
    if (!l.pay_methods.includes(b.payMethod)) throw bad('Ce moyen de paiement n’est pas accepté par le commerçant.', 'pay_method');
    if (!l.delivery.includes(b.deliveryMode)) throw bad('Ce mode de remise n’est pas proposé.', 'delivery');
    if (b.quantity > l.stock) throw bad('Quantité supérieure au stock disponible.', 'stock');
    const c = await getOrCreateConversation(t, l, req.user.id);
    const o = await t.one(
      `INSERT INTO orders (listing_id, conversation_id, buyer_id, seller_id, title_snapshot, unit_price_fcfa, quantity, total_fcfa, delivery_mode, pay_method, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [l.id, c.id, req.user.id, l.owner_id, l.title, l.unit_price, b.quantity, l.unit_price * b.quantity, b.deliveryMode, b.payMethod, b.note || null]);
    await postMessage(t, c.id, req.user.id,
      `Commande ${o.ref} : ${b.quantity} × ${l.title}, total ${fcfa(o.total_fcfa)}, paiement prévu par ${PAY[b.payMethod]}.${b.note ? ' ' + b.note : ''}`, 'order', o.id);
    await notify(l.owner_id, 'order', 'Nouvelle Commande', `${o.ref} : ${l.title}`, `/ma-boutique/commandes`, t);
    return o;
  });
  triggerChatbot(order.conversation_id);
  res.status(201).json({ order });
});

r.get('/orders', async (req, res) => {
  const { role } = z.object({ role: z.enum(['buyer', 'seller']).default('buyer') }).parse(req.query);
  res.json({ items: await db.many(
    `SELECT o.*, (SELECT url FROM listing_photos p WHERE p.listing_id = o.listing_id ORDER BY position LIMIT 1) photo,
       sh.name shop_name, bu.first_name || ' ' || left(bu.last_name,1) || '.' buyer_name,
       EXISTS (SELECT 1 FROM reviews rv WHERE rv.order_id = o.id AND rv.author_id = $1) reviewed
     FROM orders o JOIN users bu ON bu.id = o.buyer_id LEFT JOIN shops sh ON sh.owner_id = o.seller_id
     WHERE ${role === 'buyer' ? 'o.buyer_id' : 'o.seller_id'} = $1 ORDER BY o.created_at DESC LIMIT 200`, [req.user.id]) });
});

// Suivi d'une commande (P14) : étapes, remise, interlocuteur
r.get('/orders/:id', async (req, res) => {
  if (!z.uuid().safeParse(req.params.id).success) throw notFound('Commande introuvable.');
  const o = await db.one(
    `SELECT o.*, (SELECT url FROM listing_photos p WHERE p.listing_id = o.listing_id ORDER BY position LIMIT 1) photo,
       sh.name shop_name, sh.slug shop_slug, bu.first_name || ' ' || left(bu.last_name,1) || '.' buyer_name,
       EXISTS (SELECT 1 FROM reviews rv WHERE rv.order_id = o.id AND rv.author_id = $2) reviewed,
       (SELECT ref FROM reports rp WHERE rp.target_type = 'order' AND rp.target_id = o.id ORDER BY created_at DESC LIMIT 1) report_ref
     FROM orders o JOIN users bu ON bu.id = o.buyer_id LEFT JOIN shops sh ON sh.owner_id = o.seller_id
     WHERE o.id = $1 AND (o.buyer_id = $2 OR o.seller_id = $2)`, [req.params.id, req.user.id]);
  if (!o) throw notFound('Commande introuvable.');
  const events = await db.many(`SELECT kind, body, created_at FROM messages WHERE order_id = $1 ORDER BY created_at`, [o.id]);
  res.json({ order: o, events, role: o.seller_id === req.user.id ? 'seller' : 'buyer' });
});

// Transitions autorisées : qui peut faire quoi
const FLOW = {
  accepted: { by: 'seller', from: ['new'] },
  declined: { by: 'seller', from: ['new'] },
  scheduled: { by: 'seller', from: ['accepted', 'scheduled'] },
  cancelled: { by: 'buyer', from: ['new', 'accepted'] },
  completed: { by: 'buyer', from: ['accepted', 'scheduled'] },
};
const LABEL = { accepted: 'acceptée', declined: 'refusée', scheduled: 'remise prévue', cancelled: 'annulée', completed: 'terminée (réception confirmée)' };

r.post('/orders/:id/status', async (req, res) => {
  const b = z.object({
    status: z.enum(Object.keys(FLOW)), meetingPlace: z.string().trim().max(160).optional(), meetingAt: z.coerce.date().optional(),
  }).parse(req.body);
  const o = await db.tx(async (t) => {
    const o = await t.one('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!o || (o.buyer_id !== req.user.id && o.seller_id !== req.user.id)) throw notFound('Commande introuvable.');
    const rule = FLOW[b.status]; const me = o.seller_id === req.user.id ? 'seller' : 'buyer';
    if (rule.by !== me) throw forbidden('Cette action revient à l’autre membre.', 'wrong_party');
    if (!rule.from.includes(o.status)) throw bad(`Impossible depuis l’état actuel (${o.status}).`, 'bad_transition');
    if (b.status === 'scheduled' && !b.meetingPlace) throw bad('Indiquez le lieu de remise.', 'meeting_place');
    const u = await t.one(
      `UPDATE orders SET status = $2, meeting_place = coalesce($3, meeting_place), meeting_at = coalesce($4, meeting_at), updated_at = now() WHERE id = $1 RETURNING *`,
      [o.id, b.status, b.meetingPlace ?? null, b.meetingAt ?? null]);
    if (b.status === 'completed' && o.listing_id) {
      await t.query(`UPDATE listings SET stock = greatest(stock - $2, 0), status = CASE WHEN stock - $2 <= 0 THEN 'sold' ELSE status END WHERE id = $1`, [o.listing_id, o.quantity]);
    }
    if (o.conversation_id) {
      const extra = b.status === 'scheduled' ? ` Lieu : ${b.meetingPlace}${b.meetingAt ? ', le ' + b.meetingAt.toLocaleString('fr-FR', { timeZone: 'Africa/Dakar' }) : ''}.` : '';
      await postMessage(t, o.conversation_id, null, `Commande ${o.ref} ${LABEL[b.status]}.${extra}`, 'system', o.id);
    }
    const other = me === 'seller' ? o.buyer_id : o.seller_id;
    await notify(other, 'order', `Commande ${o.ref}`, `Commande ${LABEL[b.status]}.`, me === 'seller' ? '/commandes' : '/ma-boutique/commandes', t);
    return u;
  });
  res.json({ order: o });
});

r.post('/orders/:id/review', async (req, res) => {
  const b = z.object({ rating: z.coerce.number().int().min(1).max(5), tags: z.array(z.string().max(40)).max(6).default([]), comment: z.string().trim().max(600).optional() }).parse(req.body);
  const o = await db.one('SELECT * FROM orders WHERE id = $1 AND (buyer_id = $2 OR seller_id = $2)', [req.params.id, req.user.id]);
  if (!o) throw notFound('Commande introuvable.');
  if (o.status !== 'completed') throw bad('Vous pourrez noter après la remise.', 'not_completed');
  const target = o.buyer_id === req.user.id ? o.seller_id : o.buyer_id;
  const rv = await db.one(
    `INSERT INTO reviews (order_id, author_id, target_id, rating, tags, comment) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (order_id, author_id) DO NOTHING RETURNING *`, [o.id, req.user.id, target, b.rating, b.tags, b.comment || null]);
  if (!rv) throw bad('Vous avez déjà noté cette commande.', 'already_reviewed');
  res.status(201).json({ review: rv });
});

// ---------- Signalements (pas de remboursement par la plateforme) ----------
async function reportedUser(type, id) {
  if (type === 'user') return id;
  if (type === 'listing') return (await db.one('SELECT sh.owner_id FROM listings l JOIN shops sh ON sh.id = l.shop_id WHERE l.id = $1', [id]))?.owner_id;
  return null;
}
r.post('/reports', async (req, res) => {
  const b = z.object({
    targetType: z.enum(['listing', 'user', 'order']), targetId: z.uuid(),
    reason: z.enum(['not_received', 'not_as_described', 'scam', 'prohibited', 'behaviour', 'other']),
    details: z.string().trim().max(2000).optional(),
  }).parse(req.body);
  let reported = await reportedUser(b.targetType, b.targetId);
  if (b.targetType === 'order') {
    const o = await db.one('SELECT buyer_id, seller_id FROM orders WHERE id = $1 AND (buyer_id = $2 OR seller_id = $2)', [b.targetId, req.user.id]);
    if (!o) throw notFound('Commande introuvable.');
    reported = o.buyer_id === req.user.id ? o.seller_id : o.buyer_id;
  }
  if (reported === req.user.id) throw bad('Vous ne pouvez pas vous signaler vous-même.', 'self');
  const rp = await db.one('INSERT INTO reports (reporter_id, target_type, target_id, reason, details, reported_user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, ref, status',
    [req.user.id, b.targetType, b.targetId, b.reason, b.details || null, reported || null]);
  await audit(req.user.id, 'report.created', `${b.targetType}:${b.targetId}`, { ref: rp.ref, reason: b.reason });
  if (reported) await notify(reported, 'report', `Signalement ${rp.ref}`, 'Un signalement vous concerne. Vous pouvez donner votre version.', `/signalements/${rp.id}`);
  res.status(201).json({ report: rp });
});

const myReport = async (id, uid) => {
  if (!z.uuid().safeParse(id).success) throw notFound('Signalement introuvable.');
  const rp = await db.one('SELECT * FROM reports WHERE id = $1 AND (reporter_id = $2 OR reported_user_id = $2)', [id, uid]);
  if (!rp) throw notFound('Signalement introuvable.');
  return { ...rp, party: rp.reporter_id === uid ? 'reporter' : 'reported' };
};
r.get('/reports', async (req, res) => {
  res.json({ items: await db.many(`SELECT id, ref, target_type, reason, status, decision, created_at, (reporter_id = $1) mine FROM reports WHERE reporter_id = $1 OR reported_user_id = $1 ORDER BY created_at DESC`, [req.user.id]) });
});
r.get('/reports/:id', async (req, res) => {
  const rp = await myReport(req.params.id, req.user.id);
  const messages = await db.many(`SELECT party, body, created_at FROM report_messages WHERE report_id = $1 AND (party = $2 OR party = 'staff') ORDER BY created_at`, [rp.id, rp.party]);
  const evidence = await db.one('SELECT count(*)::int n FROM report_evidence WHERE report_id = $1 AND uploader_id = $2', [rp.id, req.user.id]);
  res.json({ report: { id: rp.id, ref: rp.ref, reason: rp.reason, details: rp.party === 'reporter' ? rp.details : null, status: rp.status, decision: rp.decision, decision_note: rp.decision_note, created_at: rp.created_at, party: rp.party }, messages, evidence: evidence.n });
});
r.post('/reports/:id/messages', async (req, res) => {
  const rp = await myReport(req.params.id, req.user.id);
  if (rp.status !== 'open') throw bad('Ce signalement est clos.', 'closed');
  const { body } = z.object({ body: z.string().trim().min(2).max(2000) }).parse(req.body);
  await db.query('INSERT INTO report_messages (report_id, author_id, party, body) VALUES ($1,$2,$3,$4)', [rp.id, req.user.id, rp.party, body]);
  res.status(201).json({ ok: true });
});
// Preuves photo : stockage privé, visibles uniquement par l'équipe de modération
r.post('/reports/:id/evidence', kycUpload.array('files', 4), async (req, res) => {
  const files = req.files || [];
  try {
    const rp = await myReport(req.params.id, req.user.id);
    if (!files.length) throw bad('Ajoutez au moins une photo.', 'files');
    for (const f of files) {
      await optimize(f, { max: 1600, quality: 80, format: 'jpeg' });
      await db.query('INSERT INTO report_evidence (report_id, uploader_id, file) VALUES ($1,$2,$3)', [rp.id, req.user.id, f.path]);
    }
    res.status(201).json({ added: files.length });
  } catch (e) { files.forEach((f) => removeFile(f.path)); throw e; }
});

export default r;
