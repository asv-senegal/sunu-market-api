// SM-IA : client de l'API Anthropic (Messages), facturation au token en crédits, garde-fous.
// La clé ANTHROPIC_API_KEY reste côté serveur. Chaque commerçant paie ses propres crédits ;
// la modération et le pré-contrôle d'identité sont payés par la plateforme.
import fs from 'node:fs/promises';
import { db } from '../db.js';
import { settings } from './settings.js';
import { balance, move, usedToday, pricing, costOf, estimate, insufficient } from './credits.js';
import { HttpError } from './http.js';
import { audit, notify } from './audit.js';

const API = () => process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const pending = new Set();
// Permet aux tests d'attendre la fin des traitements en arrière-plan
export const idle = () => Promise.allSettled([...pending]);
const background = (p) => { pending.add(p); p.catch((e) => console.error('[SM-IA]', e.message)).finally(() => pending.delete(p)); };

export async function aiSettings(userId) {
  return (await db.one('SELECT * FROM ai_settings WHERE user_id = $1', [userId]))
    || db.one('INSERT INTO ai_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id RETURNING *', [userId]);
}

const unavailable = (m) => new HttpError(503, m, 'smia_unavailable');

// Appel unique au modèle, avec contrôle du solde, du plafond quotidien et journalisation du coût réel
export async function callClaude({ userId = null, feature, system, messages, tools, toolChoice, maxTokens = 600 }) {
  const s = await settings();
  if (!s.smia_enabled) throw unavailable('SM-IA est temporairement coupé par l’administration.');
  if (!process.env.ANTHROPIC_API_KEY) throw unavailable('SM-IA n’est pas encore configuré sur ce serveur.');
  const p = await pricing();
  const chars = JSON.stringify([system, messages, tools || []]).length;
  const reserve = estimate(chars, maxTokens, p);
  if (userId) {
    const st = await aiSettings(userId);
    if (!st.enabled) throw new HttpError(403, 'Vous avez coupé SM-IA. Réactivez-le dans l’Assistant SM-IA.', 'smia_off');
    const [bal, today] = await Promise.all([balance(userId), usedToday(userId)]);
    if (bal < reserve) throw insufficient(reserve, bal);
    if (today + reserve > st.daily_credit_cap) throw new HttpError(429, `Limite quotidienne de ${st.daily_credit_cap} crédits atteinte. Modifiez-la dans l’Assistant SM-IA.`, 'daily_cap');
  }
  const model = s.smia_model || 'claude-haiku-5-5';
  let d; let error = null;
  try {
    const r = await fetch(`${API()}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, ...(tools ? { tools } : {}), ...(toolChoice ? { tool_choice: toolChoice } : {}) }),
      signal: AbortSignal.timeout(45_000),
    });
    d = await r.json().catch(() => ({}));
    if (!r.ok) error = d?.error?.message || `HTTP ${r.status}`;
  } catch (e) { error = e.message; }
  const usage = d?.usage || {};
  const { usd, credits } = error ? { usd: 0, credits: 0 } : costOf(usage, p);
  const charged = userId ? credits : 0;
  return db.tx(async (t) => {
    const call = await t.one(
      `INSERT INTO ai_calls (user_id, feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, credits, ok, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [userId, feature, model, usage.input_tokens || 0, usage.output_tokens || 0, usage.cache_read_input_tokens || 0, usage.cache_creation_input_tokens || 0, usd, charged, !error, error]);
    if (error) throw new HttpError(502, 'SM-IA n’a pas pu répondre. Aucun crédit n’a été débité. Réessayez dans un instant.', 'smia_error');
    if (charged) await move(t, userId, -charged, 'usage', { aiCallId: call.id, note: feature });
    const blocks = d.content || [];
    return {
      callId: call.id, credits: charged, blocks,
      text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
      tools: blocks.filter((b) => b.type === 'tool_use'),
    };
  });
}

const STYLE = 'Réponds toujours en français simple et chaleureux, adapté à Dakar. Montants en FCFA avec espace des milliers (ex. 2 500 FCFA). N’invente jamais de prix, de stock, de délai ni de promesse.';

// ---------- Rédaction d'annonce (P22) ----------
const LISTING_TOOL = {
  name: 'ecrire_annonce', description: 'Renvoie un titre et une description d’annonce.',
  input_schema: { type: 'object', properties: { title: { type: 'string', description: '90 caractères maximum' }, description: { type: 'string', description: '600 caractères maximum, phrases complètes' } }, required: ['title', 'description'] },
};
export async function describeListing(userId, input) {
  const r = await callClaude({
    userId, feature: 'description', maxTokens: 500, tools: [LISTING_TOOL], toolChoice: { type: 'tool', name: 'ecrire_annonce' },
    system: `Tu es SM-IA, l’assistant de rédaction des commerçants de Sunu-Market (marketplace de Dakar). ${STYLE} Rédige une annonce claire, honnête et vendeuse, uniquement à partir des informations fournies. Mentionne l’état réel. Pas d’allégation médicale, pas de superlatifs invérifiables.`,
    messages: [{ role: 'user', content: `Catégorie : ${input.category || 'non précisée'}\nTitre proposé : ${input.title || ''}\nÉtat : ${input.condition || ''}\nNotes du commerçant : ${input.notes || ''}` }],
  });
  const out = r.tools[0]?.input || {};
  return { title: String(out.title || input.title || '').slice(0, 90), description: String(out.description || '').slice(0, 3000), credits: r.credits };
}

// ---------- Amélioration d'une annonce (P21), soumise à accord ----------
export async function improveListing(userId, listing) {
  const st = await aiSettings(userId);
  const r = await describeListing(userId, { title: listing.title, category: listing.sub, condition: listing.condition, notes: listing.description });
  const auto = st.autonomy === 3;
  const a = await db.one(
    `INSERT INTO ai_actions (user_id, source, kind, status, summary, payload, credits, listing_id, decided_at)
     VALUES ($1,'assistant','listing_update',$2,$3,$4,$5,$6,$7) RETURNING *`,
    [userId, auto ? 'done' : 'pending', `Nouveau texte proposé pour « ${listing.title} »`, { title: r.title, description: r.description }, r.credits, listing.id, auto ? new Date() : null]);
  if (auto) await db.query('UPDATE listings SET title = $2, description = $3, updated_at = now() WHERE id = $1', [listing.id, r.title, r.description]);
  return a;
}

// ---------- Assistant SM-IA (P27) ----------
const PROPOSE_TOOL = {
  name: 'proposer_action',
  description: 'Propose une action au commerçant. Rien n’est exécuté ni payé sans son accord explicite.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['featured', 'campaign', 'listing_update', 'price_change', 'other'] },
      listing_id: { type: 'string', description: 'Identifiant de l’annonce concernée, si applicable' },
      summary: { type: 'string', description: 'Phrase courte expliquant la proposition et sa raison' },
      title: { type: 'string' }, description: { type: 'string' }, price_fcfa: { type: 'integer' }, days: { type: 'integer' },
    },
    required: ['kind', 'summary'],
  },
};

export async function assistantChat(userId, text) {
  const shop = await db.one('SELECT * FROM shops WHERE owner_id = $1', [userId]);
  const st = await aiSettings(userId);
  const ctx = shop ? await db.one(
    `SELECT (SELECT coalesce(sum(total_fcfa),0)::int FROM orders WHERE seller_id = $1 AND status = 'completed' AND updated_at > now() - interval '30 days') ventes_30j,
            (SELECT count(*)::int FROM orders WHERE seller_id = $1 AND status IN ('new','accepted','scheduled')) commandes_en_cours,
            (SELECT json_agg(x) FROM (SELECT l.id, l.title, l.price_fcfa, l.stock, l.views, l.status,
               (SELECT count(*)::int FROM orders o WHERE o.listing_id = l.id AND o.status = 'completed') vendus
             FROM listings l WHERE l.shop_id = $2 AND l.status IN ('active','paused') ORDER BY l.views DESC LIMIT 12) x) annonces`,
    [userId, shop.id]) : null;
  const history = (await db.many('SELECT role, content FROM ai_messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', [userId])).reverse();
  const s = await settings();
  const r = await callClaude({
    userId, feature: 'assistant', maxTokens: 700, tools: [PROPOSE_TOOL],
    system: `Tu es SM-IA, le conseiller personnel d’un commerçant sur Sunu-Market, marketplace de Dakar sans commission sur les ventes (le paiement se fait directement entre membres). ${STYLE}
Niveau d’autonomie choisi : ${st.autonomy} (1 = tu conseilles et proposes ; 2 = tu prépares des brouillons ; 3 = textes d’annonces appliqués seuls, jamais les prix, annulations ni dépenses).
Tu peux proposer une mise en avant ou une campagne (payantes, jamais lancées sans accord), une nouvelle rédaction d’annonce ou un changement de prix (toujours soumis à accord), via l’outil proposer_action. Maximum deux propositions par réponse. Sois bref (6 phrases maximum).
Date : ${new Date().toLocaleDateString('fr-FR', { timeZone: 'Africa/Dakar', dateStyle: 'full' })}. Tarifs de visibilité fixés : ${s.featured_price_per_day_fcfa ? 'oui' : 'non, ne cite aucun prix'}.
Données de la boutique « ${shop?.name || 'non créée'} » : ${JSON.stringify(ctx)}`,
    messages: [...history.map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: text }],
  });
  const proposals = [];
  await db.tx(async (t) => {
    await t.query('INSERT INTO ai_messages (user_id, role, content) VALUES ($1,$2,$3)', [userId, 'user', text]);
    for (const tu of r.tools.slice(0, 2)) {
      const i = tu.input || {};
      const listing = i.listing_id && shop ? await t.one('SELECT id FROM listings WHERE id::text = $1 AND shop_id = $2', [i.listing_id, shop.id]) : null;
      const auto = st.autonomy === 3 && i.kind === 'listing_update' && listing && (i.title || i.description);
      if (auto) await t.query('UPDATE listings SET title = coalesce($2, title), description = coalesce($3, description), updated_at = now() WHERE id = $1', [listing.id, i.title || null, i.description || null]);
      proposals.push(await t.one(
        `INSERT INTO ai_actions (user_id, source, kind, status, summary, payload, listing_id, decided_at) VALUES ($1,'assistant',$2,$3,$4,$5,$6,$7) RETURNING *`,
        [userId, i.kind, auto ? 'done' : 'pending', String(i.summary).slice(0, 400), { title: i.title, description: i.description, price_fcfa: i.price_fcfa, days: i.days }, listing?.id || null, auto ? new Date() : null]));
    }
    const answer = r.text || (proposals.length ? 'Voici ma proposition, à valider de votre côté.' : 'Je n’ai pas de proposition pour le moment.');
    await t.query('INSERT INTO ai_messages (user_id, role, content, credits) VALUES ($1,$2,$3,$4)', [userId, 'assistant', answer, r.credits]);
  });
  return { credits: r.credits, proposals };
}

// ---------- SM-IA Commandes : réponses automatiques dans SM-Chat (P24) ----------
export function triggerChatbot(conversationId) { background(runChatbot(conversationId)); }

async function runChatbot(conversationId) {
  const s = await settings();
  if (!s.smia_enabled || !s.smia_chatbot_enabled || !process.env.ANTHROPIC_API_KEY) return;
  const c = await db.one(`SELECT c.*, u.last_seen_at seller_seen, u.first_name seller_first FROM conversations c JOIN users u ON u.id = c.seller_id WHERE c.id = $1`, [conversationId]);
  if (!c) return;
  const st = await aiSettings(c.seller_id);
  if (!st.enabled || !st.chatbot_enabled) return;
  if (st.chatbot_mode === 'offline' && c.seller_seen && Date.now() - new Date(c.seller_seen).getTime() < 3 * 60_000) return;
  const last = await db.one('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1', [c.id]);
  if (!last || last.sender_id !== c.buyer_id) return; // ne répond qu'au dernier message de l'acheteur
  const bal = await balance(c.seller_id);
  if (bal < st.min_balance_stop) {
    const recent = await db.one(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'smia_low' AND created_at > now() - interval '24 hours'`, [c.seller_id]);
    if (!recent) await notify(c.seller_id, 'smia_low', 'SM-IA En Pause : Solde Bas', `Votre solde (${bal} crédits) est sous votre seuil de ${st.min_balance_stop}. Rechargez pour réactiver les réponses automatiques.`, '/ma-boutique/sm-ia/recharger');
    return;
  }
  const info = await db.one(
    `SELECT l.id, l.title, l.price_fcfa, l.stock, l.condition, l.delivery, l.pay_methods, l.status, l.description, sh.name shop, sh.quarter
     FROM conversations c JOIN listings l ON l.id = c.listing_id JOIN shops sh ON sh.id = l.shop_id WHERE c.id = $1`, [c.id]);
  const orders = await db.many(`SELECT id, ref, status, quantity, total_fcfa, pay_method, delivery_mode FROM orders WHERE conversation_id = $1 AND status IN ('new','accepted','scheduled')`, [c.id]);
  const hist = (await db.many('SELECT sender_id, kind, body FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 12', [c.id])).reverse();
  const maxOrder = Math.min(st.max_order_fcfa, Number(s.smia_max_order_fcfa) || st.max_order_fcfa);
  const tools = [];
  if (st.perm_accept) tools.push({ name: 'accepter_commande', description: `Accepte une commande au prix affiché si le stock suffit et si le total ne dépasse pas ${maxOrder} FCFA.`, input_schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } });
  if (st.perm_meeting) tools.push({ name: 'proposer_rendez_vous', description: 'Propose un lieu et une heure de remise, uniquement dans les créneaux et lieux du commerçant.', input_schema: { type: 'object', properties: { lieu: { type: 'string' }, quand: { type: 'string' } }, required: ['lieu', 'quand'] } });
  tools.push({ name: 'transmettre_au_commercant', description: 'Transmet au commerçant toute demande que tu ne peux pas traiter seul : remise, changement de prix, annulation, réclamation, question hors annonce.', input_schema: { type: 'object', properties: { type: { type: 'string', enum: ['remise', 'annulation', 'reclamation', 'autre'] }, resume: { type: 'string' } }, required: ['type', 'resume'] } });
  const transcript = hist.map((m) => `${m.sender_id === c.buyer_id ? 'Acheteur' : m.sender_id ? 'Commerçant' : 'Système'} : ${m.body}`).join('\n');
  let r;
  try {
    r = await callClaude({
      userId: c.seller_id, feature: 'chatbot', maxTokens: 400, tools,
      system: `Tu es SM-IA, l’assistant de la boutique « ${info?.shop} » sur Sunu-Market (Dakar). Tu réponds dans SM-Chat à la place du commerçant ${c.seller_first}, qui est absent. ${STYLE}
Règles strictes : utilise uniquement les informations de l’annonce ci-dessous ; ne négocie jamais le prix, n’accorde aucune remise, n’annule rien, ne promets aucun remboursement (Sunu-Market n’encaisse pas les paiements, ils se font directement à la remise) ; transmets ces demandes au commerçant. Conseille de payer à la remise après vérification. Réponse courte (3 phrases maximum).
${st.perm_answer ? '' : 'Tu ne réponds pas aux questions : transmets-les au commerçant et indique à l’acheteur qu’il sera recontacté.'}
Annonce : ${JSON.stringify(info)}
Commandes en cours dans cette conversation : ${JSON.stringify(orders)}
Créneaux et lieux de remise du commerçant : ${st.meeting_info || 'non précisés : propose de convenir du lieu avec le commerçant'}`,
      messages: [{ role: 'user', content: `Conversation :\n${transcript}\n\nRédige la réponse de SM-IA au dernier message de l’acheteur, et utilise les outils si nécessaire.` }],
    });
  } catch (e) {
    if (e.code === 'credits_insufficient' || e.code === 'daily_cap') await notify(c.seller_id, 'smia_low', 'SM-IA En Pause', e.message, '/ma-boutique/sm-ia');
    return;
  }
  const share = Math.max(1, Math.round(r.credits / Math.max(1, r.tools.length + 1)));
  await db.tx(async (t) => {
    for (const tu of r.tools) {
      const i = tu.input || {};
      if (tu.name === 'accepter_commande') {
        const o = orders.find((x) => x.id === i.order_id) && await t.one('SELECT o.*, l.stock FROM orders o LEFT JOIN listings l ON l.id = o.listing_id WHERE o.id = $1 FOR UPDATE OF o', [i.order_id]);
        const ok = o && o.status === 'new' && o.total_fcfa <= maxOrder && (o.stock ?? 0) >= o.quantity;
        if (ok) {
          await t.query(`UPDATE orders SET status = 'accepted', updated_at = now() WHERE id = $1`, [o.id]);
          await t.query(`INSERT INTO messages (conversation_id, sender_id, kind, body, order_id) VALUES ($1,NULL,'system',$2,$3)`, [c.id, `Commande ${o.ref} acceptée par SM-IA, dans les limites fixées par le commerçant.`, o.id]);
          await notify(c.buyer_id, 'order', `Commande ${o.ref}`, 'Commande acceptée.', `/commandes/${o.id}`, t);
          await notify(c.seller_id, 'smia', 'SM-IA A Accepté Une Commande', `${o.ref} au prix affiché (${o.total_fcfa} FCFA).`, '/ma-boutique/commandes', t);
        } else if (o) {
          await notify(c.seller_id, 'smia', 'Commande À Valider', `SM-IA n’a pas pu accepter ${o.ref} seul (limite, stock ou état). Votre accord est requis.`, '/ma-boutique/commandes', t);
        }
        await t.query(`INSERT INTO ai_actions (user_id, source, kind, status, summary, payload, credits, conversation_id, order_id) VALUES ($1,'chatbot','accept_order',$2,$3,$4,$5,$6,$7)`,
          [c.seller_id, ok ? 'done' : 'blocked', ok ? `Commande ${o.ref} acceptée, stock vérifié` : `Acceptation bloquée (limite ou stock), transmise à vous`, i, share, c.id, o?.id || null]);
      } else if (tu.name === 'proposer_rendez_vous') {
        await t.query(`INSERT INTO ai_actions (user_id, source, kind, status, summary, payload, credits, conversation_id) VALUES ($1,'chatbot','propose_meeting','done',$2,$3,$4,$5)`,
          [c.seller_id, `Rendez-vous proposé : ${i.lieu}, ${i.quand}`, i, share, c.id]);
      } else if (tu.name === 'transmettre_au_commercant') {
        await t.query(`INSERT INTO ai_actions (user_id, source, kind, status, summary, payload, credits, conversation_id) VALUES ($1,'chatbot',$2,'pending',$3,$4,$5,$6)`,
          [c.seller_id, `${i.type}_request`, `Demande transmise (${i.type}) : ${String(i.resume).slice(0, 200)}`, i, share, c.id]);
        await notify(c.seller_id, 'smia', 'Votre Accord Est Requis', String(i.resume).slice(0, 140), `/messages/${c.id}`, t);
      }
    }
    if (r.text) {
      await t.query(`INSERT INTO messages (conversation_id, sender_id, kind, body) VALUES ($1,$2,'ai',$3)`, [c.id, c.seller_id, r.text.slice(0, 1500)]);
      await t.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [c.id]);
      await t.query(`INSERT INTO ai_actions (user_id, source, kind, status, summary, credits, conversation_id) VALUES ($1,'chatbot','reply','done',$2,$3,$4)`,
        [c.seller_id, `Réponse : ${r.text.slice(0, 120)}`, r.tools.length ? 0 : r.credits, c.id]);
    }
  });
}

// ---------- Modération du catalogue (payée par la plateforme) ----------
export function triggerModeration(listingId) { background(moderate(listingId)); }
async function moderate(listingId) {
  const s = await settings();
  if (!s.smia_enabled || !s.smia_moderation_enabled || !process.env.ANTHROPIC_API_KEY) return;
  const l = await db.one(`SELECT l.id, l.title, l.description, s.name sub, sh.owner_id FROM listings l JOIN subcategories s ON s.id = l.subcategory_id JOIN shops sh ON sh.id = l.shop_id WHERE l.id = $1`, [listingId]);
  if (!l) return;
  const r = await callClaude({
    feature: 'moderation', maxTokens: 200, toolChoice: { type: 'tool', name: 'resultat' },
    tools: [{ name: 'resultat', description: 'Résultat de la modération', input_schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['ok', 'a_verifier'] }, motifs: { type: 'array', items: { type: 'string' } } }, required: ['verdict'] } }],
    system: `Tu modères les annonces de Sunu-Market (Dakar). Articles interdits : ${JSON.stringify(s.prohibited_items)}. Signale aussi les allégations médicales ou de santé, les contrefaçons manifestes et les contenus trompeurs. En cas de doute, « a_verifier ». Ta décision n’est qu’un avis : un modérateur humain tranche.`,
    messages: [{ role: 'user', content: `Sous-catégorie : ${l.sub}\nTitre : ${l.title}\nDescription : ${l.description}` }],
  });
  const v = r.tools[0]?.input || {};
  if (v.verdict === 'a_verifier') {
    await db.query(`INSERT INTO reports (reporter_id, target_type, target_id, reason, details, reported_user_id) VALUES (NULL,'listing',$1,'prohibited',$2,$3)`,
      [l.id, `Signalement automatique SM-IA : ${(v.motifs || []).join(' ; ') || 'à vérifier'}`, l.owner_id]);
    await db.query(`INSERT INTO ai_actions (user_id, source, kind, status, summary, payload, listing_id) VALUES (NULL,'moderation','listing_check','flagged',$1,$2,$3)`,
      [`« ${l.title} » : ${(v.motifs || []).join(', ') || 'à vérifier'}`, v, l.id]);
  }
}

// ---------- Pré-contrôle des pièces (avis seulement, payé par la plateforme) ----------
// Vérifie la lisibilité et la présence d'un visage. Aucune comparaison biométrique : la décision reste humaine.
export function triggerKycPrecheck(verificationId) { background(kycPrecheck(verificationId)); }
async function kycPrecheck(id) {
  const s = await settings();
  if (!s.smia_enabled || !s.smia_kyc_precheck_enabled || !process.env.ANTHROPIC_API_KEY) return;
  const v = await db.one('SELECT * FROM verifications WHERE id = $1', [id]);
  if (!v?.doc_file || !v?.selfie_file) return;
  const img = async (p) => ({ type: 'image', source: { type: 'base64', media_type: p.endsWith('.png') ? 'image/png' : p.endsWith('.webp') ? 'image/webp' : 'image/jpeg', data: (await fs.readFile(p)).toString('base64') } });
  const r = await callClaude({
    feature: 'kyc_precheck', maxTokens: 250, toolChoice: { type: 'tool', name: 'avis' },
    tools: [{ name: 'avis', description: 'Avis de pré-contrôle', input_schema: { type: 'object', properties: {
      document_lisible: { type: 'boolean' }, type_document: { type: 'string' }, selfie_un_seul_visage: { type: 'boolean' }, problemes: { type: 'array', items: { type: 'string' } } }, required: ['document_lisible', 'selfie_un_seul_visage'] } }],
    system: 'Tu fais un pré-contrôle de qualité pour un modérateur humain. Ne lis pas et ne recopie aucune donnée personnelle. Ne compare pas les visages. Indique seulement si la pièce semble lisible, son type apparent, et si le selfie montre un seul visage net.',
    messages: [{ role: 'user', content: [await img(v.doc_file), await img(v.selfie_file), { type: 'text', text: 'Image 1 : pièce. Image 2 : selfie.' }] }],
  });
  const a = r.tools[0]?.input || {};
  await db.query('UPDATE verifications SET ai_precheck = $2 WHERE id = $1', [id, a]);
  await db.query(`INSERT INTO ai_actions (user_id, source, kind, status, summary, payload) VALUES (NULL,'kyc_precheck','precheck','advice',$1,$2)`,
    [`Pré-contrôle : pièce ${a.document_lisible ? 'lisible' : 'à revoir'}, selfie ${a.selfie_un_seul_visage ? 'conforme' : 'à revoir'}`, a]);
  await audit(null, 'verification.precheck', `verification:${id}`, { advisory: true });
}
