// Vérifie les garde-fous de SM-IA contre le simulateur local (aucun crédit débité : appels « plateforme »).
// Usage : node --env-file=.env scripts/check-smia-guards.mjs   (avec « npm run demo » lancé)
// Toujours le simulateur : ce script ne doit jamais appeler l'API réelle
process.env.ANTHROPIC_API_KEY = 'demo';
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:4100';
const { callClaude } = await import('../src/lib/smia.js');
const { db } = await import('../src/db.js');

const tool = { name: 'proposer_action', input_schema: { type: 'object' } };
const system = '"id":"00000000-0000-0000-0000-000000000000"';
const results = {};
for (const [name, args] of Object.entries({
  coupee: { maxTokens: 300, tools: [tool], messages: [{ role: 'user', content: 'Bonjour' }] },
  refus: { maxTokens: 1500, tools: [tool], messages: [{ role: 'user', content: '[refus]' }] },
  normale: { maxTokens: 1500, tools: [tool], messages: [{ role: 'user', content: 'Bonjour' }] },
})) {
  try {
    const r = await callClaude({ feature: `test_${name}`, system, ...args });
    results[name] = { ok: true, text: r.text, tools: r.tools.length };
  } catch (e) { results[name] = { ok: false, code: e.code, status: e.status }; }
}
const logged = await db.many(`SELECT feature, ok, error, credits, cost_usd FROM ai_calls WHERE feature LIKE 'test_%' AND created_at > now() - interval '2 minutes' ORDER BY created_at`);
console.log(JSON.stringify({ results, logged }, null, 2));
await db.query(`DELETE FROM ai_calls WHERE feature LIKE 'test_%' AND user_id IS NULL`);
await db.end();
