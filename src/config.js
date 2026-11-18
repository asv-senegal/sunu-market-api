import { fileURLToPath } from 'node:url';
const req = (k, d) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`Variable d'environnement manquante : ${k}`);
  return v;
};
export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.API_PORT || 4000),
  databaseUrl: req('DATABASE_URL'),
  dbDriver: process.env.DB_DRIVER || 'pg', // 'pg' (TCP 5432) ou 'neon' (WebSocket 443)
  jwtSecret: req('JWT_SECRET', process.env.NODE_ENV === 'production' ? undefined : 'dev-secret-a-changer'),
  storageDir: process.env.STORAGE_DIR || fileURLToPath(new URL('../storage', import.meta.url)),
  webOrigin: process.env.WEB_ORIGIN || 'http://localhost:5173',
};
