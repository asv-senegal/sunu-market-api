import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../db.js';
import { bad, HttpError } from '../lib/http.js';
import { normalizePhone } from '../lib/text.js';
import { signToken, publicUser } from '../lib/auth.js';
import crypto from 'node:crypto';
import { sendSms, smsIsConsole } from '../lib/sms.js';
import { audit } from '../lib/audit.js';

// Code SMS exigé à l'inscription (désactivable en développement avec OTP_REQUIRED=false)
const otpRequired = () => process.env.OTP_REQUIRED !== 'false';
const hashCode = (phone, code) => crypto.createHash('sha256').update(`${phone}:${code}:${process.env.JWT_SECRET || ''}`).digest('hex');

async function checkCode(phone, purpose, code) {
  const c = await db.one(`SELECT * FROM sms_codes WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, [phone, purpose]);
  if (!c || c.attempts >= 5) throw bad('Code expiré ou trop de tentatives. Demandez un nouveau code.', 'otp_expired');
  const ok = crypto.timingSafeEqual(Buffer.from(c.code_hash), Buffer.from(hashCode(phone, String(code || ''))));
  if (!ok) { await db.query('UPDATE sms_codes SET attempts = attempts + 1 WHERE id = $1', [c.id]); throw bad('Code incorrect.', 'otp_invalid'); }
  await db.query('UPDATE sms_codes SET consumed_at = now() WHERE id = $1', [c.id]);
}

const r = Router();
// Limites comptées par numéro de téléphone : le navigateur ne parle jamais à l'API, toutes les demandes
// arrivent du serveur web avec la même adresse IP ; une limite par IP bloquerait tous les membres à la fois.
const byPhone = (req) => {
  const p = normalizePhone(String(req.body?.phone ?? ''));
  return p ? `tel:${p}` : `ip:${ipKeyGenerator(req.ip || '')}`;
};
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: byPhone, message: { error: 'Trop de tentatives. Réessayez dans quelques minutes.', code: 'rate_limit' } });

const phone = z.string().transform((v, ctx) => {
  const p = normalizePhone(v);
  if (!p) { ctx.addIssue({ code: 'custom', message: 'Numéro sénégalais invalide (ex. 77 123 45 67).' }); return z.NEVER; }
  return p;
});

const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false, skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: byPhone, message: { error: 'Trop de demandes de code. Réessayez dans 15 minutes.', code: 'rate_limit' } });

// Envoi d'un code à 6 chiffres, valable 10 minutes, 5 essais maximum
r.post('/otp', otpLimiter, async (req, res) => {
  const b = z.object({ phone, purpose: z.enum(['register', 'login', 'reset']) }).parse(req.body);
  const exists = await db.one('SELECT 1 FROM users WHERE phone = $1', [b.phone]);
  if (b.purpose === 'register' && exists) throw bad('Ce numéro est déjà utilisé.', 'phone_taken');
  if (b.purpose !== 'register' && !exists) return res.json({ sent: true }); // ne révèle pas l'existence du compte
  const recent = await db.one(`SELECT count(*)::int n FROM sms_codes WHERE phone = $1 AND created_at > now() - interval '15 minutes'`, [b.phone]);
  if (recent.n >= 3) throw bad('Trois codes envoyés récemment. Patientez 15 minutes.', 'rate_limit');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await db.query(`INSERT INTO sms_codes (phone, purpose, code_hash, expires_at) VALUES ($1,$2,$3, now() + interval '10 minutes')`, [b.phone, b.purpose, hashCode(b.phone, code)]);
  await sendSms(b.phone, `Votre code Sunu-Market : ${code}. Il expire dans 10 minutes. Ne le communiquez à personne.`);
  // En développement uniquement, le code est renvoyé pour faciliter les essais
  res.json({ sent: true, ...(smsIsConsole() && process.env.NODE_ENV !== 'production' ? { devCode: code } : {}) });
});

// Connexion par code SMS (P07)
r.post('/login-otp', limiter, async (req, res) => {
  const b = z.object({ phone, code: z.string().regex(/^\d{6}$/) }).parse(req.body);
  await checkCode(b.phone, 'login', b.code);
  const u = await db.one('SELECT * FROM users WHERE phone = $1', [b.phone]);
  if (!u) throw new HttpError(401, 'Numéro ou code incorrect.', 'bad_credentials');
  await db.query('UPDATE users SET phone_verified_at = coalesce(phone_verified_at, now()) WHERE id = $1', [u.id]);
  res.json({ token: signToken(u), user: publicUser(u) });
});

// Étape 1 de l'inscription. Le compte reste inactif tant que la vérification n'est pas validée.
r.post('/register', limiter, async (req, res) => {
  const b = z.object({
    firstName: z.string().trim().min(2).max(60),
    lastName: z.string().trim().min(2).max(60),
    phone,
    password: z.string().min(8, 'Au moins 8 caractères.').max(100),
    quarter: z.string().trim().max(80).optional(),
    consent: z.literal(true, { error: 'Le consentement est obligatoire.' }),
    code: z.string().optional(),
  }).parse(req.body);
  if (await db.one('SELECT 1 FROM users WHERE phone = $1', [b.phone])) throw bad('Ce numéro est déjà utilisé.', 'phone_taken');
  if (otpRequired()) await checkCode(b.phone, 'register', b.code);
  const u = await db.one(
    `INSERT INTO users (first_name, last_name, phone, password_hash, quarter, consent_at, phone_verified_at)
     VALUES ($1,$2,$3,$4,$5,now(),${otpRequired() ? 'now()' : 'NULL'}) RETURNING *`,
    [b.firstName, b.lastName, b.phone, await bcrypt.hash(b.password, 10), b.quarter || null]);
  res.status(201).json({ token: signToken(u), user: publicUser(u) });
});

// Mot de passe oublié : code SMS puis nouveau mot de passe (P07, lien « Mot De Passe Oublié »)
r.post('/reset-password', limiter, async (req, res) => {
  const b = z.object({ phone, code: z.string().regex(/^\d{6}$/, 'Le code compte 6 chiffres.'), password: z.string().min(8, 'Au moins 8 caractères.').max(100) }).parse(req.body);
  await checkCode(b.phone, 'reset', b.code);
  const u = await db.one(`UPDATE users SET password_hash = $2, password_changed_at = now(), phone_verified_at = coalesce(phone_verified_at, now()), updated_at = now()
    WHERE phone = $1 RETURNING *`, [b.phone, await bcrypt.hash(b.password, 10)]);
  if (!u) throw new HttpError(400, 'Code expiré ou incorrect.', 'otp_invalid');
  await audit(u.id, 'auth.password_reset', `user:${u.id}`, {});
  res.json({ token: signToken(u), user: publicUser(u) });
});

r.post('/login', limiter, async (req, res) => {
  const b = z.object({ phone: z.string(), password: z.string() }).parse(req.body);
  const p = normalizePhone(b.phone);
  const u = p && await db.one('SELECT * FROM users WHERE phone = $1', [p]);
  if (!u || !(await bcrypt.compare(b.password, u.password_hash))) throw new HttpError(401, 'Numéro ou mot de passe incorrect.', 'bad_credentials');
  res.json({ token: signToken(u), user: publicUser(u) });
});

export default r;
