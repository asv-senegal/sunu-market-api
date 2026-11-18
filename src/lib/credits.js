// Portefeuille de crédits SM-IA : solde, octrois, débits à l'usage réel (tokens)
import { db } from '../db.js';
import { settings } from './settings.js';
import { HttpError } from './http.js';

export async function balance(userId, t = db) {
  return (await t.one('SELECT balance FROM credit_wallets WHERE user_id = $1', [userId]))?.balance ?? 0;
}

// Ajoute ou retire des crédits avec une ligne de journal (dans une transaction fournie)
export async function move(t, userId, delta, kind, { note, paymentId, aiCallId } = {}) {
  const w = await t.one(
    `INSERT INTO credit_wallets (user_id, balance) VALUES ($1, greatest($2, 0))
     ON CONFLICT (user_id) DO UPDATE SET balance = greatest(credit_wallets.balance + $2, 0), updated_at = now()
     RETURNING balance`, [userId, delta]);
  await t.query('INSERT INTO credit_ledger (user_id, delta, kind, payment_id, ai_call_id, note, balance_after) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [userId, delta, kind, paymentId || null, aiCallId || null, note || null, w.balance]);
  return w.balance;
}

export async function usedToday(userId) {
  return (await db.one(`SELECT coalesce(sum(credits),0)::int n FROM ai_calls WHERE user_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Dakar') AT TIME ZONE 'Africa/Dakar'`, [userId])).n;
}

// Barème : 1 crédit = smia_credit_cost_usd de coût API réel (0,0001 $ par défaut, soit 1 000 tokens d'entrée de Claude Haiku 5.5)
export async function pricing() {
  const s = await settings();
  return {
    model: s.smia_model, inUsd: Number(s.smia_price_input_usd_mtok), outUsd: Number(s.smia_price_output_usd_mtok),
    creditUsd: Number(s.smia_credit_cost_usd), usdXof: Number(s.usd_xof),
    creditsPer1000: Number(s.smia_credits_per_1000_fcfa), commissionPct: Number(s.smia_recharge_commission_pct),
    packs: s.smia_recharge_packs_fcfa, minRecharge: Number(s.smia_min_recharge_fcfa),
    trialCredits: Number(s.smia_trial_credits), subscriptionCredits: Number(s.smia_subscription_credits),
  };
}

export function costOf(usage, p) {
  const usd = ((usage.input_tokens || 0) * p.inUsd + (usage.cache_creation_input_tokens || 0) * p.inUsd * 1.25
    + (usage.cache_read_input_tokens || 0) * p.inUsd * 0.1 + (usage.output_tokens || 0) * p.outUsd) / 1e6;
  return { usd, credits: Math.max(1, Math.ceil(usd / p.creditUsd - 1e-9)) };
}

// Estimation maximale avant l'appel (entrée estimée à 1 token pour 3 caractères, sortie au plafond max_tokens)
export function estimate(chars, maxTokens, p) {
  return costOf({ input_tokens: Math.ceil(chars / 3), output_tokens: maxTokens }, p).credits;
}

// Recharge : crédits obtenus et commission pour un montant en FCFA
export function quote(amount, p) {
  const credits = Math.floor((amount * p.creditsPer1000) / 1000);
  const commission = Math.round((amount * p.commissionPct) / 100);
  return { amount, credits, commission, total: amount + commission };
}

export const insufficient = (need, have) => new HttpError(402, `Crédits SM-IA insuffisants (${need} nécessaires, solde ${have}). Rechargez vos crédits pour continuer.`, 'credits_insufficient');
