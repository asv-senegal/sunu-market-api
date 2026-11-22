# Sunu-Market : API (backend)

API de Sunu-Market : comptes vérifiés, catalogue, boutiques, SM-Chat, commandes en paiement direct, SM-IA et crédits, paiements des services, administration. Elle est utilisée par le site (dépôt **sunu-market-web**). Document confidentiel, réservé à l'équipe.

## Technologies

Node.js 22, Express 5, PostgreSQL (Neon en production), Zod, JWT, Multer et Sharp pour les images, API Anthropic pour SM-IA.

## Démarrage

```bash
npm install
cp .env.example .env      # DATABASE_URL, JWT_SECRET, etc.
npm run migrate           # applique migrations/*.sql
npm run seed              # 12 catégories et 93 sous-catégories
npm run seed -- --demo    # (facultatif, hors production) comptes, boutiques et annonces fictifs
npm run create-admin -- "+221XXXXXXXXX" "MotDePasseDe12Caracteres" "Prénom" "Nom"
npm run dev               # http://localhost:4000
```

| Commande | Rôle |
|---|---|
| `npm run dev` | Développement (redémarre à chaque modification) |
| `npm run demo` | API + simulateur SM-IA local, sans clé Anthropic |
| `npm start` | Production |
| `npm test` | 8 tests de bout en bout (base dédiée, voir `.env.test.example`) |
| `npm run mock-ai` | Simulateur de l'API Anthropic seul (port 4100) |

## Règles métier

- **Vérification obligatoire** (pièce et selfie) avant toute action. Les images sont supprimées dès la décision (loi n° 2008-12).
- **Paiement direct entre membres**, échanges et commandes dans SM-Chat. L'API n'encaisse que les services : abonnement, crédits SM-IA, mise en avant, campagnes, publicité.
- **Abonnement réservé aux boutiques** : 14 jours d'essai, puis 2 500 FCFA par an.
- **SM-IA** facturé au token. 1 crédit = 0,0001 $ de coût réel. Barème proposé : 4 000 crédits pour 1 000 FCFA, plus 1 % de commission sur la recharge [à valider]. Garde-fous : solde, plafond quotidien, seuil d'arrêt, coupure individuelle et générale, journal. Les actions sensibles restent soumises à l'accord du commerçant.
- **Idempotence** (`src/lib/idempotency.js`) : paiements, commandes, messages SM-Chat et SM-IA acceptent l'en-tête `Idempotency-Key`. Une demande renvoyée (double clic, nouvel essai réseau) renvoie la première réponse au lieu de recréer ; même clé avec un autre contenu : 422 ; demande encore en cours : 409 `request_in_progress`. Clés conservées 24 h. Une référence de transaction déclarée ne sert qu'à un seul paiement (index unique).
- **Journal d'audit** en ajout seul, empreintes chaînées (`GET /api/admin/audit/verify`).

## Organisation

```
src/routes/   auth, me, catalog, seller, smia, payments, social (SM-Chat, commandes, avis, signalements), admin
src/lib/      auth, credits, smia (Anthropic), payments (Wave, Orange Money), sms, images, settings, audit
migrations/   schéma SQL versionné
scripts/      migrate, seed (taxonomy.json), create-admin, mock-anthropic, demo
test/         flow.test.js, smia.test.js
```

## Déploiement

Mise en ligne automatique sur PlanetHoster N0C par GitHub Actions (tests, FTP, SSH) : voir **[DEPLOYMENT.md](DEPLOYMENT.md)** et `.github/workflows/deploy.yml`. Démarrage par Passenger : `server.cjs` ; tâches de fond par cron : `npm run jobs`.

- Variables : voir `.env.example`. La clé `ANTHROPIC_API_KEY` reste uniquement sur le serveur.
- `WEB_ORIGIN` doit contenir l'adresse publique du site.
- Les fichiers envoyés sont stockés dans `storage/` : en production, prévoir un disque persistant ou un stockage objet.
- Webhooks : `POST /api/payments/webhooks/wave` et `POST /api/payments/webhooks/orange-money` (définir `API_PUBLIC_URL`).
- Tâches de fond (`src/lib/jobs.js`, lancées avec le serveur) : rapprochement des paiements Wave et Orange Money restés en attente (contrôles espacés, 7 jours maximum) et rappels d'abonnement (7 jours avant, la veille, à l'expiration ; notification et SMS selon les préférences). Un verrou PostgreSQL évite les doublons entre serveurs ; `JOBS_DISABLED=1` les coupe sur un serveur.
