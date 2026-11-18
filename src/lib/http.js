import { ZodError, z } from 'zod';

export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export const bad = (m, c) => new HttpError(400, m, c);
export const forbidden = (m = 'Action non autorisée.', c = 'forbidden') => new HttpError(403, m, c);
export const notFound = (m = 'Élément introuvable.') => new HttpError(404, m, 'not_found');

// Valide req.body / req.query avec un schéma zod
export const parse = (schema, data) => schema.parse(data);

export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Certains champs sont invalides.', code: 'validation', fields: z.flattenError(err).fieldErrors });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Fichier trop lourd (5 Mo maximum).', code: 'file_size' });
  console.error(err);
  res.status(500).json({ error: 'Erreur interne. Réessayez dans un instant.', code: 'internal' });
}
