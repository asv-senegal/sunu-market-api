import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { db } from '../db.js';
import { HttpError, forbidden } from './http.js';

export const signToken = (user) => jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: '30d' });

// Lit le jeton « Authorization: Bearer … » et charge le membre
export async function loadUser(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return next();
  let sub;
  try {
    ({ sub } = jwt.verify(token, config.jwtSecret));
  } catch { return next(); } // jeton invalide ou expiré : visiteur
  // Une erreur de base de données n'est pas un jeton invalide : on la signale au lieu de déconnecter tout le monde
  // (par exemple une migration non appliquée, qui ferait échouer cette requête pour chaque membre).
  try {
    req.user = await db.one(
      `SELECT id, first_name, last_name, phone, quarter, city, role, verification_status, status, last_seen_at, created_at, deletion_requested_at FROM users WHERE id = $1`, [sub]);
    // Présence du commerçant (SM-IA Commandes répond quand il est hors ligne)
    if (req.user && (!req.user.last_seen_at || Date.now() - new Date(req.user.last_seen_at).getTime() > 60_000)) {
      db.query('UPDATE users SET last_seen_at = now() WHERE id = $1', [sub]).catch(() => {});
    }
    next();
  } catch (err) {
    next(err); // erreur 500 journalisée par le gestionnaire d'erreurs, visible dans le journal de l'API
  }
}

export const requireAuth = (req, _res, next) => (req.user ? next() : next(new HttpError(401, 'Connectez-vous pour continuer.', 'auth_required')));

// Vérification obligatoire : rien n'est possible tant que le compte n'est pas vérifié
export function requireVerified(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Connectez-vous pour continuer.', 'auth_required'));
  if (req.user.status === 'suspended') return next(forbidden('Votre compte est suspendu.', 'suspended'));
  if (req.user.verification_status !== 'verified') return next(forbidden('Votre compte doit être vérifié avant cette action.', 'not_verified'));
  next();
}

export const requireRole = (...roles) => (req, _res, next) =>
  (req.user && roles.includes(req.user.role) ? next() : next(forbidden('Accès réservé à l’administration.', 'role')));

// Équipe Sunu-Market et droits par rôle (P36). L'administrateur a tous les droits.
export const STAFF = ['admin', 'moderator', 'finance', 'support'];
export const PERMS = ['verify', 'moderate', 'revenue', 'smia', 'export'];
export async function permsOf(role) {
  if (role === 'admin') return [...PERMS, 'settings'];
  const { setting } = await import('./settings.js');
  return ((await setting('role_permissions')) || {})[role] || [];
}
export const requirePerm = (perm) => async (req, _res, next) => {
  if (!req.user || !STAFF.includes(req.user.role)) return next(forbidden('Accès réservé à l’administration.', 'role'));
  if (!(await permsOf(req.user.role)).includes(perm)) return next(forbidden('Votre rôle ne donne pas accès à cette action.', 'perm'));
  next();
};

export const publicUser = (u) => u && ({
  id: u.id, firstName: u.first_name, lastName: u.last_name, phone: u.phone, quarter: u.quarter, city: u.city,
  role: u.role, verificationStatus: u.verification_status, status: u.status,
  createdAt: u.created_at, deletionRequestedAt: u.deletion_requested_at || null,
});
