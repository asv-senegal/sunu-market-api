// Envoi de SMS : fournisseur interchangeable (variable SMS_PROVIDER).
//  - console : développement ; le code est écrit dans le journal du serveur (jamais en production)
//  - http    : passerelle générique (SMS_HTTP_URL + SMS_HTTP_TOKEN), à brancher sur le prestataire retenu [à confirmer]
//  - orange  : API SMS Orange (OAuth2 client credentials) [identifiants et expéditeur à obtenir auprès de Sonatel]
const provider = () => process.env.SMS_PROVIDER || (process.env.NODE_ENV === 'production' ? 'http' : 'console');
export const smsIsConsole = () => provider() === 'console';

let orangeToken = { value: null, exp: 0 };
async function orangeAuth() {
  if (orangeToken.value && Date.now() < orangeToken.exp) return orangeToken.value;
  const r = await fetch(process.env.ORANGE_SMS_TOKEN_URL || 'https://api.orange.com/oauth/v3/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${process.env.ORANGE_SMS_CLIENT_ID}:${process.env.ORANGE_SMS_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`Orange SMS auth ${r.status}`);
  const d = await r.json();
  orangeToken = { value: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return orangeToken.value;
}

export async function sendSms(phone, text) {
  const p = provider();
  if (p === 'console') { console.log(`[SMS → ${phone}] ${text}`); return { ok: true }; }
  if (p === 'http') {
    const r = await fetch(process.env.SMS_HTTP_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SMS_HTTP_TOKEN}` },
      body: JSON.stringify({ to: phone, from: process.env.SMS_SENDER || 'SunuMarket', text }),
    });
    return { ok: r.ok };
  }
  if (p === 'orange') {
    const sender = process.env.ORANGE_SMS_SENDER; // ex. tel:+221XXXXXXXXX
    const r = await fetch(`https://api.orange.com/smsmessaging/v1/outbound/${encodeURIComponent(sender)}/requests`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await orangeAuth()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ outboundSMSMessageRequest: { address: `tel:${phone}`, senderAddress: sender, senderName: 'SunuMarket', outboundSMSTextMessage: { message: text } } }),
    });
    return { ok: r.ok };
  }
  throw new Error(`Fournisseur SMS inconnu : ${p}`);
}
