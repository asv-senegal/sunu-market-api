// Espace Administrateur : droits par rôle (P36). verify = vérifications ; moderate = annonces et signalements ;
// revenue = revenus et remboursements ; smia = réglages SM-IA ; export = exports ; settings = administrateur seul.
import { Router } from 'express';
import fs from 'node:fs';
import { z } from 'zod';
import { db } from '../db.js';
import { bad, notFound, forbidden } from '../lib/http.js';
import { requirePerm, STAFF, permsOf } from '../lib/auth.js';
import { audit, notify } from '../lib/audit.js';
import { removeFile } from '../lib/upload.js';
import { markPaid, purposeLabel } from '../lib/payments.js';
import { clearSettingsCache, settings } from '../lib/settings.js';
import { normalizePhone } from '../lib/text.js';
import { verifyAuditChain } from '../lib/audit-verify.js';

const r = Router();
r.use((req, _res, next) => (req.user && STAFF.includes(req.user.role) ? next() : next(forbidden('Accès réservé à l’administration.', 'role'))));
const csv = (res, name, head, rows) => {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` })
    .send('﻿' + [head.join(';'), ...rows.map((x) => x.map(esc).join(';'))].join('\r\n'));
};

r.get('/me', async (req, res) => res.json({ role: req.user.role, perms: await permsOf(req.user.role) }));

r.get('/stats', async (_req, res) => {
  const k = await db.one(
    `SELECT (SELECT count(*)::int FROM users WHERE verification_status = 'verified') verified_users,
            (SELECT count(*)::int FROM users) users,
            (SELECT count(*)::int FROM verifications WHERE status = 'pending') pending_verifications,
            (SELECT count(*)::int FROM shops) shops,
            (SELECT count(*)::int FROM subscriptions WHERE kind = 'annual' AND status = 'active' AND ends_at > now()) paying_shops,
            (SELECT count(*)::int FROM subscriptions WHERE kind = 'trial' AND status = 'active' AND ends_at > now()) trial_shops,
            (SELECT count(*)::int FROM payments WHERE status = 'pending' AND provider = 'manual') pending_payments,
            (SELECT count(*)::int FROM listings WHERE status = 'active') active_listings,
            (SELECT count(*)::int FROM reports WHERE status = 'open') open_reports,
            (SELECT count(*)::int FROM orders WHERE created_at > now() - interval '30 days') orders_30d,
            (SELECT coalesce(sum(total_fcfa),0)::int FROM payments WHERE status = 'paid' AND paid_at > date_trunc('month', now())) revenue_month`);
  const byCategory = await db.many(
    `SELECT c.name, count(l.id)::int n FROM categories c LEFT JOIN subcategories s ON s.category_id = c.id
     LEFT JOIN listings l ON l.subcategory_id = s.id AND l.status = 'active' WHERE NOT c.is_shops GROUP BY c.id ORDER BY c.position`);
  const signups = await db.many(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day, (SELECT count(*)::int FROM users u WHERE u.created_at::date = d::date) n
     FROM generate_series(now() - interval '13 days', now(), interval '1 day') d`);
  res.json({ kpi: k, byCategory, signups, revenue: await revenueSeries() });
});

// Revenus par mois (6 derniers) et par source ; commission seule pour les recharges SM-IA
async function revenueSeries() {
  const months = await db.many(
    `SELECT to_char(m, 'YYYY-MM') AS month,
       (SELECT coalesce(sum(CASE WHEN purpose = 'credits' THEN commission_fcfa ELSE total_fcfa END),0)::int FROM payments
        WHERE status = 'paid' AND date_trunc('month', paid_at) = m) total
     FROM generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') m`);
  const split = await db.many(
    `SELECT purpose, coalesce(sum(CASE WHEN purpose = 'credits' THEN commission_fcfa ELSE total_fcfa END),0)::int amount, count(*)::int n
     FROM payments WHERE status = 'paid' AND paid_at > date_trunc('month', now()) - interval '5 months' GROUP BY purpose`);
  return { months, split };
}

// ---------- Vérifications d'identité ----------
r.get('/verifications', requirePerm('verify'), async (req, res) => {
  const { status } = z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') }).parse(req.query);
  res.json({ items: await db.many(
    `SELECT v.id, v.doc_type, v.status, v.reason, v.submitted_at, v.decided_at, (v.doc_file IS NOT NULL) has_files, v.ai_precheck,
       u.id user_id, u.first_name, u.last_name, u.phone, u.quarter, u.created_at user_since, (u.phone_verified_at IS NOT NULL) phone_verified
     FROM verifications v JOIN users u ON u.id = v.user_id WHERE v.status = $1 ORDER BY v.submitted_at ASC LIMIT 100`, [status]) });
});

r.get('/verifications/:id/file/:kind', requirePerm('verify'), async (req, res) => {
  const kind = z.enum(['document', 'selfie']).parse(req.params.kind);
  const v = await db.one('SELECT doc_file, selfie_file FROM verifications WHERE id = $1', [req.params.id]);
  const p = v && (kind === 'document' ? v.doc_file : v.selfie_file);
  if (!p || !fs.existsSync(p)) throw notFound('Fichier supprimé ou introuvable.');
  await audit(req.user.id, 'verification.file_viewed', `verification:${req.params.id}`, { kind });
  res.set('Cache-Control', 'no-store').sendFile(p);
});

r.post('/verifications/:id/decision', requirePerm('verify'), async (req, res) => {
  const b = z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string().trim().max(300).optional() }).parse(req.body);
  if (b.decision === 'rejected' && !b.reason) throw bad('Indiquez le motif du refus.', 'reason_required');
  const v = await db.tx(async (t) => {
    const v = await t.one(`SELECT * FROM verifications WHERE id = $1 AND status = 'pending' FOR UPDATE`, [req.params.id]);
    if (!v) throw notFound('Dossier introuvable ou déjà traité.');
    // Minimisation (loi n° 2008-12) : seule la décision est conservée, les images sont supprimées
    await t.query(`UPDATE verifications SET status = $2, reason = $3, reviewer_id = $4, decided_at = now(), doc_file = NULL, selfie_file = NULL WHERE id = $1`,
      [v.id, b.decision, b.reason || null, req.user.id]);
    await t.query(`UPDATE users SET verification_status = $2, updated_at = now() WHERE id = $1`, [v.user_id, b.decision === 'approved' ? 'verified' : 'rejected']);
    await audit(req.user.id, `verification.${b.decision}`, `user:${v.user_id}`, { reason: b.reason }, t);
    await notify(v.user_id, 'verification', b.decision === 'approved' ? 'Compte Vérifié' : 'Vérification Refusée',
      b.decision === 'approved' ? 'Bienvenue sur Sunu-Market ! Vous pouvez acheter, écrire et ouvrir votre boutique.' : `Motif : ${b.reason}. Vous pouvez soumettre un nouveau dossier.`,
      b.decision === 'approved' ? '/' : '/verification', t);
    return v;
  });
  removeFile(v.doc_file); removeFile(v.selfie_file);
  res.json({ ok: true });
});

// ---------- Annonces, boutiques, catégories, articles interdits (P31) ----------
r.get('/listings', requirePerm('moderate'), async (req, res) => {
  const { q, flagged } = z.object({ q: z.string().trim().max(80).optional(), flagged: z.string().optional() }).parse(req.query);
  const p = []; const where = [];
  if (q) { p.push(q); where.push(`(l.title ILIKE '%' || $${p.length} || '%' OR sh.name ILIKE '%' || $${p.length} || '%')`); }
  if (flagged) where.push(`EXISTS (SELECT 1 FROM reports rp WHERE rp.target_type = 'listing' AND rp.target_id = l.id AND rp.status = 'open')`);
  res.json({ items: await db.many(
    `SELECT l.id, l.title, l.price_fcfa, l.status, l.created_at, sh.name shop_name, sh.slug shop_slug, c.name category, s.name sub, (l.featured_until > now()) featured,
       (SELECT url FROM listing_photos ph WHERE ph.listing_id = l.id ORDER BY position LIMIT 1) photo,
       (SELECT count(*)::int FROM reports rp WHERE rp.target_type = 'listing' AND rp.target_id = l.id AND rp.status = 'open') open_reports
     FROM listings l JOIN shops sh ON sh.id = l.shop_id JOIN subcategories s ON s.id = l.subcategory_id JOIN categories c ON c.id = s.category_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY open_reports DESC, l.created_at DESC LIMIT 200`, p) });
});

r.post('/listings/:id/remove', requirePerm('moderate'), async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
  const l = await db.one(`UPDATE listings l SET status = 'removed' FROM shops sh WHERE l.id = $1 AND sh.id = l.shop_id RETURNING l.id, l.title, sh.owner_id`, [req.params.id]);
  if (!l) throw notFound();
  await audit(req.user.id, 'listing.removed', `listing:${l.id}`, { reason });
  await notify(l.owner_id, 'moderation', 'Annonce Retirée', `« ${l.title} » a été retirée. Motif : ${reason}`, '/ma-boutique/annonces');
  res.json({ ok: true });
});

r.get('/shops', requirePerm('moderate'), async (_req, res) => {
  res.json({ items: await db.many(
    `SELECT sh.id, sh.slug, sh.name, sh.quarter, sh.status, sh.created_at, u.first_name || ' ' || u.last_name owner, u.status owner_status,
       (SELECT kind || ':' || to_char(ends_at, 'YYYY-MM-DD') FROM subscriptions sb WHERE sb.shop_id = sh.id AND sb.status = 'active' ORDER BY ends_at DESC LIMIT 1) subscription,
       (SELECT count(*)::int FROM listings l WHERE l.shop_id = sh.id AND l.status = 'active') listings,
       (SELECT count(*)::int FROM reports rp WHERE rp.reported_user_id = sh.owner_id) reports
     FROM shops sh JOIN users u ON u.id = sh.owner_id ORDER BY sh.created_at DESC LIMIT 300`) });
});

r.post('/shops/:id/status', requirePerm('moderate'), async (req, res) => {
  const { status, reason } = z.object({ status: z.enum(['active', 'suspended']), reason: z.string().trim().min(3).max(300) }).parse(req.body);
  const s = await db.one('UPDATE shops SET status = $2 WHERE id = $1 RETURNING id, owner_id, name', [req.params.id, status]);
  if (!s) throw notFound();
  await audit(req.user.id, `shop.${status}`, `shop:${s.id}`, { reason });
  await notify(s.owner_id, 'moderation', status === 'suspended' ? 'Boutique Suspendue' : 'Boutique Réactivée', reason, '/ma-boutique');
  res.json({ ok: true });
});

r.get('/categories', requirePerm('moderate'), async (_req, res) => {
  res.json({ items: await db.many(
    `SELECT c.id, c.name, c.slug, c.is_shops, json_agg(json_build_object('id', s.id, 'name', s.name, 'hidden', s.hidden, 'source', s.source,
       'listings', (SELECT count(*)::int FROM listings l WHERE l.subcategory_id = s.id AND l.status = 'active')) ORDER BY s.position) subs
     FROM categories c JOIN subcategories s ON s.category_id = c.id GROUP BY c.id ORDER BY c.position`) });
});
r.patch('/subcategories/:id', requirePerm('settings'), async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(60).optional(), hidden: z.boolean().optional(), position: z.number().int().optional() }).parse(req.body);
  const s = await db.one('UPDATE subcategories SET name = coalesce($2,name), hidden = coalesce($3,hidden), position = coalesce($4,position) WHERE id = $1 RETURNING *',
    [req.params.id, b.name ?? null, b.hidden ?? null, b.position ?? null]);
  if (!s) throw notFound();
  await audit(req.user.id, 'category.updated', `subcategory:${s.id}`, b);
  res.json({ subcategory: s });
});
r.post('/categories/:id/subcategories', requirePerm('settings'), async (req, res) => {
  const { name } = z.object({ name: z.string().trim().min(2).max(60) }).parse(req.body);
  const slug = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const s = await db.one(`INSERT INTO subcategories (category_id, slug, name, source, position)
    VALUES ($1,$2,$3,'P',(SELECT coalesce(max(position),0)+1 FROM subcategories WHERE category_id = $1)) RETURNING *`, [req.params.id, slug, name]);
  await audit(req.user.id, 'category.created', `subcategory:${s.id}`, { name });
  res.status(201).json({ subcategory: s });
});

// ---------- Signalements (P33) ----------
r.get('/reports', requirePerm('moderate'), async (req, res) => {
  const { status } = z.object({ status: z.enum(['open', 'closed']).default('open') }).parse(req.query);
  res.json({ items: await db.many(
    `SELECT rp.*, coalesce(u.first_name || ' ' || u.last_name, 'SM-IA (automatique)') reporter_name, ru.first_name || ' ' || ru.last_name reported_name
     FROM reports rp LEFT JOIN users u ON u.id = rp.reporter_id LEFT JOIN users ru ON ru.id = rp.reported_user_id
     WHERE rp.status = $1 ORDER BY rp.due_at ASC LIMIT 200`, [status]) });
});

r.get('/reports/:id', requirePerm('moderate'), async (req, res) => {
  const rp = await db.one(`SELECT * FROM reports WHERE id = $1`, [req.params.id]);
  if (!rp) throw notFound();
  const party = async (id) => id && db.one(
    `SELECT u.id, u.first_name || ' ' || u.last_name name, u.verification_status, u.status,
       (SELECT count(*)::int FROM orders WHERE buyer_id = u.id AND status = 'completed') purchases,
       (SELECT count(*)::int FROM orders WHERE seller_id = u.id AND status = 'completed') sales,
       (SELECT round(avg(rating)::numeric,1) FROM reviews WHERE target_id = u.id) rating,
       (SELECT count(*)::int FROM reports WHERE reported_user_id = u.id) reports_against
     FROM users u WHERE u.id = $1`, [id]);
  let target = null; let timeline = [];
  if (rp.target_type === 'listing') target = await db.one('SELECT id, title, description, price_fcfa, status, (SELECT json_agg(url) FROM listing_photos WHERE listing_id = listings.id) photos FROM listings WHERE id = $1', [rp.target_id]);
  if (rp.target_type === 'order') {
    target = await db.one('SELECT id, ref, title_snapshot, total_fcfa, pay_method, delivery_mode, status, meeting_place, created_at, conversation_id FROM orders WHERE id = $1', [rp.target_id]);
    timeline = await db.many(`SELECT kind, body, created_at FROM messages WHERE order_id = $1 ORDER BY created_at`, [rp.target_id]);
  }
  res.json({
    report: rp, target, timeline,
    reporter: await party(rp.reporter_id), reported: await party(rp.reported_user_id),
    messages: await db.many('SELECT party, body, created_at FROM report_messages WHERE report_id = $1 ORDER BY created_at', [rp.id]),
    evidence: await db.many('SELECT e.id, e.created_at, (e.uploader_id = $2) by_reporter FROM report_evidence e WHERE e.report_id = $1 ORDER BY e.created_at', [rp.id, rp.reporter_id]),
  });
});

r.get('/report-evidence/:id', requirePerm('moderate'), async (req, res) => {
  const e = await db.one('SELECT file, report_id FROM report_evidence WHERE id = $1', [req.params.id]);
  if (!e || !fs.existsSync(e.file)) throw notFound();
  await audit(req.user.id, 'report.evidence_viewed', `report:${e.report_id}`, {});
  res.set('Cache-Control', 'no-store').sendFile(e.file);
});

// « Demander une précision » à l'une des parties
r.post('/reports/:id/messages', requirePerm('moderate'), async (req, res) => {
  const b = z.object({ to: z.enum(['reporter', 'reported']), body: z.string().trim().min(3).max(1000) }).parse(req.body);
  const rp = await db.one(`SELECT * FROM reports WHERE id = $1 AND status = 'open'`, [req.params.id]);
  if (!rp) throw notFound();
  await db.query(`INSERT INTO report_messages (report_id, author_id, party, body) VALUES ($1,$2,'staff',$3)`, [rp.id, req.user.id, b.body]);
  const uid = b.to === 'reporter' ? rp.reporter_id : rp.reported_user_id;
  if (uid) await notify(uid, 'report', `Signalement ${rp.ref} : Précision Demandée`, b.body.slice(0, 140), `/signalements/${rp.id}`);
  res.status(201).json({ ok: true });
});

r.post('/reports/:id/decision', requirePerm('moderate'), async (req, res) => {
  const b = z.object({ decision: z.enum(['dismiss', 'warn', 'remove', 'suspend']), note: z.string().trim().min(3).max(500) }).parse(req.body);
  await db.tx(async (t) => {
    const rp = await t.one(`SELECT * FROM reports WHERE id = $1 AND status = 'open' FOR UPDATE`, [req.params.id]);
    if (!rp) throw notFound('Signalement introuvable ou déjà traité.');
    const userId = rp.reported_user_id;
    if (b.decision === 'remove' && rp.target_type === 'listing') await t.query(`UPDATE listings SET status = 'removed' WHERE id = $1`, [rp.target_id]);
    if (b.decision === 'suspend' && userId) await t.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [userId]);
    await t.query(`UPDATE reports SET status = 'closed', decision = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`, [rp.id, b.decision, req.user.id, b.note]);
    const label = { dismiss: 'classé', warn: 'avertissement', remove: 'annonce retirée', suspend: 'compte suspendu' }[b.decision];
    // Décision motivée, notifiée aux deux parties
    if (rp.reporter_id) await notify(rp.reporter_id, 'report', `Signalement ${rp.ref} Traité`, `Décision : ${label}. ${b.note}`, `/signalements/${rp.id}`, t);
    if (userId) await notify(userId, 'report', `Signalement ${rp.ref} : Décision`, `Décision : ${label}. ${b.note}`, `/signalements/${rp.id}`, t);
    await audit(req.user.id, `report.${b.decision}`, `report:${rp.id}`, { ref: rp.ref, note: b.note, userId }, t);
  });
  res.json({ ok: true });
});

// ---------- Paiements et revenus (P32) ----------
r.get('/revenue', requirePerm('revenue'), async (req, res) => {
  const { purpose, status } = z.object({ purpose: z.string().optional(), status: z.string().optional() }).parse(req.query);
  const p = []; const where = [];
  if (purpose === 'visibility') where.push(`py.purpose IN ('featured','campaign','ad')`); else if (purpose) { p.push(purpose); where.push(`py.purpose = $${p.length}`); }
  if (status) { p.push(status); where.push(`py.status = $${p.length}`); }
  const kpi = await db.many(
    `SELECT purpose, coalesce(sum(CASE WHEN purpose = 'credits' THEN commission_fcfa ELSE total_fcfa END),0)::int amount, count(*)::int n,
       coalesce(sum(CASE WHEN purpose = 'credits' THEN amount_fcfa ELSE 0 END),0)::int credits_volume
     FROM payments WHERE status = 'paid' AND paid_at > date_trunc('month', now()) GROUP BY purpose`);
  const items = await db.many(
    `SELECT py.*, coalesce(sh.name, u.first_name || ' ' || u.last_name) merchant FROM payments py JOIN users u ON u.id = py.user_id LEFT JOIN shops sh ON sh.id = py.shop_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY py.created_at DESC LIMIT 300`, p);
  res.json({ kpi, items: items.map((x) => ({ ...x, label: purposeLabel(x.purpose) })), series: await revenueSeries() });
});

r.get('/revenue.csv', requirePerm('export'), async (_req, res) => {
  const rows = await db.many(`SELECT py.ref, to_char(py.created_at AT TIME ZONE 'Africa/Dakar','DD/MM/YYYY HH24:MI') d, py.purpose, py.amount_fcfa, py.commission_fcfa, py.total_fcfa, py.provider, py.provider_ref, py.status FROM payments py ORDER BY py.created_at DESC`);
  await audit(null, 'export.revenue', 'payments', { rows: rows.length });
  csv(res, 'revenus-sunu-market.csv', ['Référence', 'Date', 'Service', 'Montant', 'Commission', 'Total', 'Moyen', 'Réf. prestataire', 'État'], rows.map((x) => [x.ref, x.d, purposeLabel(x.purpose), x.amount_fcfa, x.commission_fcfa, x.total_fcfa, x.provider, x.provider_ref, x.status]));
});

// Paiements déclarés manuellement (Wave ou Orange Money sans API) : à rapprocher du relevé
r.post('/payments/:id/confirm', requirePerm('revenue'), async (req, res) => {
  const { accept } = z.object({ accept: z.boolean() }).parse(req.body);
  const p = await db.one(`SELECT * FROM payments WHERE id = $1 AND status = 'pending'`, [req.params.id]);
  if (!p) throw notFound('Paiement introuvable ou déjà traité.');
  if (accept) await markPaid(p.id, req.user.id);
  else {
    await db.query(`UPDATE payments SET status = 'failed', confirmed_by = $2, updated_at = now() WHERE id = $1`, [p.id, req.user.id]);
    if (p.purpose_id) await db.query(`UPDATE promotions SET status = 'cancelled' WHERE id = $1`, [p.purpose_id]);
    await notify(p.user_id, 'subscription', 'Paiement Non Retrouvé', `Nous n’avons pas retrouvé le paiement ${p.ref}. Vérifiez la référence et recommencez.`, null);
    await audit(req.user.id, 'payment.rejected', `payment:${p.id}`, { ref: p.ref });
  }
  res.json({ ok: true });
});

// Remboursement d'un service : double validation obligatoire (finance puis administrateur, deux personnes distinctes)
r.post('/payments/:id/refund', requirePerm('revenue'), async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(5).max(300) }).parse(req.body);
  const out = await db.tx(async (t) => {
    const p = await t.one(`SELECT * FROM payments WHERE id = $1 AND status IN ('paid','refund_requested') FOR UPDATE`, [req.params.id]);
    if (!p) throw notFound('Paiement non remboursable.');
    const approvals = p.refund_approvals || [];
    if (approvals.some((a) => a.by === req.user.id)) throw bad('La seconde validation doit venir d’une autre personne.', 'same_approver');
    approvals.push({ by: req.user.id, role: req.user.role, at: new Date().toISOString(), reason });
    const roles = new Set(approvals.map((a) => a.role));
    const done = approvals.length >= 2 && roles.has('admin') && (roles.has('finance') || approvals.filter((a) => a.role === 'admin').length >= 2);
    await t.query(`UPDATE payments SET refund_approvals = $2, status = $3, updated_at = now() WHERE id = $1`, [p.id, JSON.stringify(approvals), done ? 'refunded' : 'refund_requested']);
    await audit(req.user.id, `payment.refund_${done ? 'validated' : 'requested'}`, `payment:${p.id}`, { ref: p.ref, step: approvals.length, reason }, t);
    if (done) await notify(p.user_id, 'subscription', `Remboursement ${p.ref}`, `Votre remboursement de ${p.total_fcfa} FCFA est validé. Il vous sera versé par ${p.provider === 'orange_money' ? 'Orange Money' : 'Wave'}.`, null, t);
    return { status: done ? 'refunded' : 'refund_requested', step: approvals.length };
  });
  res.json(out);
});

// ---------- SM-IA et crédits (P34) ----------
r.get('/smia', requirePerm('smia'), async (_req, res) => {
  const s = await settings();
  const k = await db.one(
    `SELECT (SELECT coalesce(sum(amount_fcfa),0)::int FROM payments WHERE purpose = 'credits' AND status = 'paid' AND paid_at > date_trunc('month', now())) recharges_month,
            (SELECT coalesce(sum(commission_fcfa),0)::int FROM payments WHERE purpose = 'credits' AND status = 'paid' AND paid_at > date_trunc('month', now())) commissions_month,
            (SELECT coalesce(sum(cost_usd),0)::float FROM ai_calls WHERE created_at > date_trunc('month', now())) cost_usd_month,
            (SELECT coalesce(sum(credits),0)::int FROM ai_calls WHERE created_at > date_trunc('month', now())) credits_used_month,
            (SELECT count(*)::int FROM ai_actions WHERE created_at > now() - interval '24 hours') actions_24h,
            (SELECT count(DISTINCT user_id)::int FROM ai_actions WHERE created_at > now() - interval '24 hours' AND user_id IS NOT NULL) shops_24h,
            (SELECT count(*)::int FROM ai_calls WHERE NOT ok AND created_at > now() - interval '24 hours') errors_24h,
            (SELECT coalesce(sum(balance),0)::int FROM credit_wallets) credits_outstanding`);
  res.json({
    kpi: { ...k, cost_fcfa_month: Math.round(k.cost_usd_month * Number(s.usd_xof)) },
    configured: !!process.env.ANTHROPIC_API_KEY,
    journal: await db.many(
      `SELECT a.id, a.source, a.kind, a.status, a.summary, a.created_at, coalesce(sh.name, 'Plateforme') shop FROM ai_actions a
       LEFT JOIN shops sh ON sh.owner_id = a.user_id ORDER BY a.created_at DESC LIMIT 80`),
    byFeature: await db.many(`SELECT feature, count(*)::int calls, coalesce(sum(credits),0)::int credits, coalesce(sum(cost_usd),0)::float cost_usd FROM ai_calls WHERE created_at > date_trunc('month', now()) GROUP BY feature ORDER BY calls DESC`),
  });
});

// Coupure générale : immédiate. La réactivation est journalisée.
r.post('/smia/power', requirePerm('smia'), async (req, res) => {
  const { on } = z.object({ on: z.boolean() }).parse(req.body);
  await db.query(`UPDATE settings SET value = $1, updated_at = now() WHERE key = 'smia_enabled'`, [JSON.stringify(on)]);
  clearSettingsCache();
  await audit(req.user.id, on ? 'smia.global_enabled' : 'smia.global_cut', 'settings:smia_enabled', {});
  res.json({ enabled: on });
});

// ---------- Équipe, rôles et paramètres (P36) ----------
r.get('/team', requirePerm('settings'), async (_req, res) => {
  res.json({
    members: await db.many(`SELECT id, first_name, last_name, phone, role, last_seen_at FROM users WHERE role <> 'member' ORDER BY role, first_name`),
    permissions: (await settings()).role_permissions,
  });
});
r.post('/team', requirePerm('settings'), async (req, res) => {
  const b = z.object({ phone: z.string(), role: z.enum(['member', 'moderator', 'finance', 'support', 'admin']) }).parse(req.body);
  const phone = normalizePhone(b.phone);
  const u = phone && await db.one(`UPDATE users SET role = $2 WHERE phone = $1 AND verification_status = 'verified' RETURNING id, first_name, role`, [phone, b.role]);
  if (!u) throw bad('Aucun compte vérifié avec ce numéro.', 'not_found');
  if (u.id === req.user.id && b.role !== 'admin') throw bad('Vous ne pouvez pas retirer votre propre rôle d’administrateur.', 'self');
  await audit(req.user.id, 'team.role_changed', `user:${u.id}`, { role: b.role });
  res.json({ member: u });
});

r.get('/settings', requirePerm('settings'), async (_req, res) => res.json({ items: await db.many('SELECT * FROM settings ORDER BY key') }));
r.patch('/settings/:key', requirePerm('settings'), async (req, res) => {
  const b = z.object({ value: z.any(), confirmed: z.boolean().optional() }).parse(req.body);
  if (req.params.key === 'role_permissions') {
    z.record(z.enum(['moderator', 'finance', 'support']), z.array(z.enum(['verify', 'moderate', 'revenue', 'smia', 'export']))).parse(b.value);
  }
  const s = await db.one('UPDATE settings SET value = $2, confirmed = coalesce($3, confirmed), updated_at = now() WHERE key = $1 RETURNING *', [req.params.key, JSON.stringify(b.value), b.confirmed ?? null]);
  if (!s) throw notFound();
  clearSettingsCache();
  await audit(req.user.id, 'settings.updated', `settings:${s.key}`, { value: b.value, confirmed: s.confirmed });
  res.json({ setting: s });
});

// ---------- Journal d'audit (P35) ----------
r.get('/audit', requirePerm('export'), async (_req, res) => {
  res.json({ items: await db.many(
    `SELECT a.*, coalesce(u.first_name || ' ' || u.last_name, 'Système') actor_name, u.role actor_role FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 300`) });
});
// Contrôle d'intégrité : recalcule toute la chaîne d'empreintes (SHA-256 de Node, sans pgcrypto)
r.get('/audit/verify', requirePerm('export'), async (_req, res) => {
  res.json(await verifyAuditChain());
});
r.get('/audit.csv', requirePerm('export'), async (req, res) => {
  const rows = await db.many(`SELECT a.id, to_char(a.created_at AT TIME ZONE 'Africa/Dakar','DD/MM/YYYY HH24:MI:SS') d, coalesce(u.first_name || ' ' || u.last_name, 'Système') actor, a.action, a.target, a.details, a.hash FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id`);
  await audit(req.user.id, 'export.audit', 'audit_log', { rows: rows.length });
  csv(res, 'journal-audit-sunu-market.csv', ['N°', 'Horodatage', 'Auteur', 'Action', 'Objet', 'Détails', 'Empreinte'], rows.map((x) => [x.id, x.d, x.actor, x.action, x.target, JSON.stringify(x.details), x.hash]));
});

export default r;
