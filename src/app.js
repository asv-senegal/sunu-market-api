import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { config } from './config.js';
import { loadUser } from './lib/auth.js';
import { errorHandler, notFound } from './lib/http.js';
import { publicDir } from './lib/upload.js';
import auth from './routes/auth.js';
import me from './routes/me.js';
import catalog from './routes/catalog.js';
import seller from './routes/seller.js';
import social from './routes/social.js';
import admin from './routes/admin.js';
import smia from './routes/smia.js';
import payments, { waveWebhook, orangeWebhook } from './routes/payments.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: config.webOrigin }));
  if (config.env !== 'test') app.use(morgan('dev'));
  // Webhooks des prestataires de paiement : corps brut pour vérifier la signature
  app.post('/api/payments/webhooks/wave', express.raw({ type: '*/*', limit: '100kb' }), waveWebhook);
  app.post('/api/payments/webhooks/orange-money', express.json(), orangeWebhook);
  app.use(express.json({ limit: '200kb' }));
  app.use('/files', express.static(publicDir, { maxAge: '7d', fallthrough: false }));
  app.get('/health', (_req, res) => res.json({ ok: true }));

  const api = express.Router();
  api.use(loadUser);
  api.use('/auth', auth);
  api.use('/me/smia', smia);
  api.use('/payments', payments);
  api.use('/me', me);
  api.use('/me', seller);   // /me/shop, /me/subscription
  api.use('/', catalog);    // /categories, /listings, /shops
  api.use('/admin', admin);
  api.use('/', social);     // /conversations, /orders, /reports
  api.use(() => { throw notFound('Route inconnue.'); });
  app.use('/api', api);
  app.use(errorHandler);
  return app;
}
