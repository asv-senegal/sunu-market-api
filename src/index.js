import { createApp } from './app.js';
import { config } from './config.js';
import { startJobs } from './lib/jobs.js';

createApp().listen(config.port, () => console.log(`API Sunu-Market sur http://localhost:${config.port}`));

// Tâches de fond (rapprochement des paiements, rappels d'abonnement). JOBS_DISABLED=1 pour les couper sur un serveur.
if (config.env !== 'test' && process.env.JOBS_DISABLED !== '1') startJobs();
