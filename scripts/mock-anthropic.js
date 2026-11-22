// Simulateur local de l'API Anthropic (Messages) pour les démonstrations hors ligne et le développement.
// Usage : node scripts/mock-anthropic.js 4100, puis ANTHROPIC_BASE_URL=http://127.0.0.1:4100 et ANTHROPIC_API_KEY=demo.
// Ne jamais utiliser en production : les réponses sont fixes.
import http from 'node:http';
const calls = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const b = JSON.parse(body);
    calls.push(b);
    const names = (b.tools || []).map((t) => t.name);
    const lastUser = JSON.stringify(b.messages.at(-1).content);
    let content;
    if (names.includes('ecrire_annonce')) {
      content = [{ type: 'tool_use', id: 't1', name: 'ecrire_annonce', input: { title: 'Smartphone Android 128 Go', description: 'Téléphone en très bon état, batterie testée.' } }];
    } else if (names.includes('resultat')) {
      content = [{ type: 'tool_use', id: 't1', name: 'resultat', input: lastUser.includes('guérit') ? { verdict: 'a_verifier', motifs: ['Allégation médicale'] } : { verdict: 'ok' } }];
    } else if (names.includes('transmettre_au_commercant')) {
      const orders = JSON.parse(b.system.match(/Commandes en cours dans cette conversation : (\[.*?\])\n/s)[1]);
      if (lastUser.includes('remise')) {
        content = [{ type: 'text', text: 'Je transmets votre demande de remise au commerçant.' },
          { type: 'tool_use', id: 't2', name: 'transmettre_au_commercant', input: { type: 'remise', resume: 'L’acheteur demande 10 % de remise.' } }];
      } else {
        content = [{ type: 'text', text: 'Bonjour, l’article est disponible. Je confirme votre commande.' },
          ...orders.filter((o) => o.status === 'new').map((o) => ({ type: 'tool_use', id: `a-${o.id}`, name: 'accepter_commande', input: { order_id: o.id } }))];
      }
    } else if (names.includes('proposer_action')) {
      const id = b.system.match(/"id":"([0-9a-f-]{36})"/)[1];
      content = [{ type: 'text', text: 'Votre titre peut être plus précis.' },
        { type: 'tool_use', id: 't3', name: 'proposer_action', input: { kind: 'listing_update', listing_id: id, summary: 'Titre plus précis', title: 'Smartphone Android 128 Go, garanti entre membres' } }];
    } else content = [{ type: 'text', text: 'ok' }];
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: b.model, ...o })); };

    // Comme Claude Haiku 5.5 : un message contenant « [refus] » est décliné (HTTP 200, stop_reason « refusal »)
    if (lastUser.includes('[refus]')) {
      return send({ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: 'Simulation de refus' }, usage: { input_tokens: 1500, output_tokens: 0 } });
    }
    // Comme Claude Haiku 5.5 : réflexion avant la réponse, sauf si un outil est imposé ; elle compte dans max_tokens.
    // Effort « low » : réflexion courte ; sinon (défaut « medium ») assez longue pour épuiser un petit plafond.
    const forced = b.tool_choice && ['tool', 'any'].includes(b.tool_choice.type);
    const thinkTokens = forced ? 0 : b.output_config?.effort === 'low' ? 150 : 900;
    if (thinkTokens && thinkTokens + 300 > b.max_tokens) {
      return send({ content: [{ type: 'thinking', thinking: '', signature: 'sim' }], stop_reason: 'max_tokens', usage: { input_tokens: 1500, output_tokens: b.max_tokens } });
    }
    if (thinkTokens) content = [{ type: 'thinking', thinking: '', signature: 'sim' }, ...content];
    send({ content, stop_reason: content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 1500, output_tokens: 300 + thinkTokens } });
  });
});

mock.listen(Number(process.argv[2] || 4100), '127.0.0.1', () => console.log('Simulateur Anthropic prêt'));
