// SM-IA côté commerçant : solde, recharges, assistant, SM-IA Commandes, propositions et journal (P22, P24, P27, P28)
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { bad, notFound } from '../lib/http.js';
import { requireVerified } from '../lib/auth.js';
import { balance, usedToday, pricing, quote } from '../lib/credits.js';
import { createPayment, liveProviders } from '../lib/payments.js';
import { aiSettings, assistantChat, describeListing, improveListing } from '../lib/smia.js';
import { settings } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { idempotent } from '../lib/idempotency.js';

const r = Router();
r.use(requireVerified);

r.get('/', async (req, res) => {
  const uid = req.user.id;
  const [st, bal, today, p, s] = await Promise.all([aiSettings(uid), balance(uid), usedToday(uid), pricing(), settings()]);
  const stats = await db.one(
    `SELECT (SELECT count(*)::int FROM ai_actions WHERE user_id = $1 AND source = 'chatbot' AND kind = 'reply' AND created_at > now() - interval '30 days') replies,
            (SELECT count(*)::int FROM ai_actions WHERE user_id = $1 AND kind = 'accept_order' AND status = 'done' AND created_at > now() - interval '30 days') accepted,
            (SELECT coalesce(sum(credits),0)::int FROM ai_calls WHERE user_id = $1 AND created_at > now() - interval '30 days') used_30d,
            (SELECT coalesce(sum(credits),0)::int FROM ai_calls WHERE user_id = $1 AND created_at > now() - interval '7 days') used_7d`, [uid]);
  res.json({
    settings: st, balance: bal, usedToday: today, stats,
    // Durée estimée du solde au rythme des 7 derniers jours
    daysLeft: stats.used_7d > 0 ? Math.floor(bal / (stats.used_7d / 7)) : null,
    global: { enabled: !!s.smia_enabled, chatbot: !!s.smia_chatbot_enabled, assistant: !!s.smia_assistant_enabled, configured: !!process.env.ANTHROPIC_API_KEY },
    pricing: { packs: p.packs.map((a) => quote(a, p)), min: p.minRecharge, commissionPct: p.commissionPct, creditsPer1000: p.creditsPer1000 },
    live: liveProviders(),
    pending: await db.many(`SELECT * FROM ai_actions WHERE user_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 20`, [uid]),
    journal: await db.many(`SELECT id, source, kind, status, summary, credits, created_at, conversation_id, order_id FROM ai_actions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 40`, [uid]),
    ledger: await db.many(`SELECT delta, kind, note, balance_after, created_at FROM credit_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [uid]),
    chat: (await db.many(`SELECT role, content, credits, created_at FROM ai_messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [uid])).reverse(),
    payments: await db.many(`SELECT ref, amount_fcfa, commission_fcfa, total_fcfa, credits, provider, status, created_at FROM payments WHERE user_id = $1 AND purpose = 'credits' ORDER BY created_at DESC LIMIT 10`, [uid]),
  });
});

r.patch('/', async (req, res) => {
  const b = z.object({
    enabled: z.boolean().optional(), autonomy: z.number().int().min(1).max(3).optional(),
    daily_credit_cap: z.number().int().min(0).max(100000).optional(), min_balance_stop: z.number().int().min(0).max(100000).optional(),
    chatbot_enabled: z.boolean().optional(), chatbot_mode: z.enum(['offline', 'always']).optional(),
    perm_answer: z.boolean().optional(), perm_accept: z.boolean().optional(), perm_meeting: z.boolean().optional(),
    max_order_fcfa: z.number().int().min(0).max(10_000_000).optional(), meeting_info: z.string().trim().max(400).optional(),
  }).parse(req.body);
  await aiSettings(req.user.id);
  const keys = Object.keys(b);
  if (!keys.length) throw bad('Aucune modification.');
  const st = await db.one(`UPDATE ai_settings SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE user_id = $1 RETURNING *`, [req.user.id, ...keys.map((k) => b[k])]);
  await audit(req.user.id, 'smia.settings', `user:${req.user.id}`, b);
  res.json({ settings: st });
});

// Couper SM-IA immédiatement (toutes fonctions), réactivable à tout moment
r.post('/power', async (req, res) => {
  const { on } = z.object({ on: z.boolean() }).parse(req.body);
  await aiSettings(req.user.id);
  await db.query('UPDATE ai_settings SET enabled = $2, updated_at = now() WHERE user_id = $1', [req.user.id, on]);
  await audit(req.user.id, on ? 'smia.enabled' : 'smia.cut', `user:${req.user.id}`, {});
  res.json({ enabled: on });
});

r.post('/assistant', idempotent('smia_assistant'), async (req, res) => {
  const { text } = z.object({ text: z.string().trim().min(2).max(1000) }).parse(req.body);
  if (!(await settings()).smia_assistant_enabled) throw bad('L’Assistant SM-IA est désactivé par l’administration.', 'assistant_off');
  res.json(await assistantChat(req.user.id, text));
});

r.post('/describe', idempotent('smia_describe'), async (req, res) => {
  const b = z.object({ title: z.string().trim().max(120).optional(), subcategoryId: z.coerce.number().int().optional(), condition: z.string().max(20).optional(), notes: z.string().trim().max(1500).optional() }).parse(req.body);
  const sub = b.subcategoryId ? await db.one('SELECT s.name, c.name cat FROM subcategories s JOIN categories c ON c.id = s.category_id WHERE s.id = $1', [b.subcategoryId]) : null;
  if (!b.title && !b.notes) throw bad('Indiquez au moins un titre ou quelques notes.', 'empty');
  res.json(await describeListing(req.user.id, { ...b, category: sub ? `${sub.cat} > ${sub.name}` : undefined }));
});

r.post('/listings/:id/improve', idempotent('smia_improve'), async (req, res) => {
  const l = await db.one(`SELECT l.*, s.name sub FROM listings l JOIN shops sh ON sh.id = l.shop_id JOIN subcategories s ON s.id = l.subcategory_id WHERE l.id = $1 AND sh.owner_id = $2`, [req.params.id, req.user.id]);
  if (!l) throw notFound('Annonce introuvable.');
  res.status(201).json({ action: await improveListing(req.user.id, l) });
});

// Accord ou refus d'une proposition de SM-IA (rien n'est exécuté sans accord explicite)
r.post('/actions/:id/:decision', async (req, res) => {
  const decision = z.enum(['approve', 'reject']).parse(req.params.decision);
  const out = await db.tx(async (t) => {
    const a = await t.one(`SELECT * FROM ai_actions WHERE id = $1 AND user_id = $2 AND status = 'pending' FOR UPDATE`, [req.params.id, req.user.id]);
    if (!a) throw notFound('Proposition introuvable ou déjà traitée.');
    let next = null;
    if (decision === 'approve') {
      const p = a.payload || {};
      if (a.listing_id && (a.kind === 'listing_update' || a.kind === 'price_change')) {
        const own = await t.one('SELECT l.id FROM listings l JOIN shops sh ON sh.id = l.shop_id WHERE l.id = $1 AND sh.owner_id = $2', [a.listing_id, req.user.id]);
        if (!own) throw notFound('Annonce introuvable.');
        if (a.kind === 'listing_update') await t.query('UPDATE listings SET title = coalesce($2, title), description = coalesce($3, description), updated_at = now() WHERE id = $1', [a.listing_id, p.title || null, p.description || null]);
        if (a.kind === 'price_change' && Number.isInteger(p.price_fcfa) && p.price_fcfa >= 0) await t.query('UPDATE listings SET price_fcfa = $2, updated_at = now() WHERE id = $1', [a.listing_id, p.price_fcfa]);
      }
      // Visibilité payante : l'accord ouvre le formulaire de paiement, rien n'est payé automatiquement
      if (a.kind === 'featured' || a.kind === 'campaign') next = `/ma-boutique/visibilite?type=${a.kind}${a.listing_id ? `&annonce=${a.listing_id}` : ''}${p.days ? `&jours=${p.days}` : ''}`;
      if (a.conversation_id) next = `/messages/${a.conversation_id}`;
    }
    await t.query(`UPDATE ai_actions SET status = $2, decided_at = now() WHERE id = $1`, [a.id, decision === 'approve' ? 'approved' : 'rejected']);
    await audit(req.user.id, `smia.proposal_${decision}d`, `ai_action:${a.id}`, { kind: a.kind }, t);
    return { next };
  });
  res.json({ ok: true, ...out });
});

// Recharge de crédits (P28) : montant + commission, paiement Wave ou Orange Money
r.get('/quote', async (req, res) => {
  const { amount } = z.object({ amount: z.coerce.number().int().min(1).max(1_000_000) }).parse(req.query);
  res.json(quote(amount, await pricing()));
});
r.post('/recharge', idempotent('credits'), async (req, res) => {
  const b = z.object({ amount: z.number().int().max(1_000_000), payMethod: z.enum(['wave', 'orange_money']), payRef: z.string().trim().min(4).max(60).optional() }).parse(req.body);
  const p = await pricing();
  if (b.amount < p.minRecharge) throw bad(`Recharge minimale : ${p.minRecharge} FCFA.`, 'min_amount');
  if (!liveProviders()[b.payMethod] && !b.payRef) throw bad('Indiquez la référence de la transaction reçue par SMS.', 'pay_ref');
  const q = quote(b.amount, p);
  const pay = await createPayment({ userId: req.user.id, purpose: 'credits', amount: q.amount, commission: q.commission, credits: q.credits, provider: b.payMethod, payRef: b.payRef });
  res.status(201).json({ payment: pay, quote: q });
});

r.get('/journal.csv', async (req, res) => {
  const rows = await db.many(`SELECT to_char(created_at AT TIME ZONE 'Africa/Dakar', 'DD/MM/YYYY HH24:MI') d, source, kind, status, summary, credits FROM ai_actions WHERE user_id = $1 ORDER BY created_at DESC`, [req.user.id]);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['Date;Source;Action;État;Résumé;Crédits', ...rows.map((x) => [x.d, x.source, x.kind, x.status, x.summary, x.credits].map(esc).join(';'))].join('\r\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="journal-sm-ia.csv"' }).send('﻿' + csv);
});

export default r;
