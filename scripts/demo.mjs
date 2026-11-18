// Démonstration locale (Windows, macOS, Linux) : simulateur SM-IA (port 4100) + API (port 4000).
// Usage : npm run demo
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try { process.loadEnvFile(path.join(root, '.env')); } catch { console.error('Fichier .env introuvable : copiez .env.example en .env.'); process.exit(1); }
const env = { ...process.env };
if (!env.ANTHROPIC_API_KEY) { env.ANTHROPIC_API_KEY = 'demo'; env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:4100'; }
const procs = [];
const run = (name, args) => {
  const p = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  p.stdout.on('data', out); p.stderr.on('data', out);
  procs.push(p);
};
if (env.ANTHROPIC_BASE_URL?.includes('127.0.0.1:4100')) run('SM-IA simulé', ['scripts/mock-anthropic.js', '4100']);
run('API', ['src/index.js']);
const stop = () => { procs.forEach((p) => p.kill()); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
