#!/usr/bin/env bash
# Installation et mise à jour de l'API sur le serveur (N0C / cPanel), depuis le terminal.
# Avant : activez l'environnement Node de l'application (commande affichée dans N0C → Node.js), par exemple
#   source ~/nodevenv/sunumarketapi/22/bin/activate && cd ~/sunumarketapi
# Puis : bash scripts/server-update.sh
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[31mArrêt : %s\033[0m\n' "$1"; exit 1; }

# ---------- Vérifications ----------
command -v node >/dev/null || fail "node introuvable : activez d'abord l'environnement Node (voir SETUP.md, étape 5)."
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' \
  || fail "Node $(node -v) actif : il faut Node 22 ou plus. Activez l'environnement Node de l'application (voir SETUP.md)."
if [ -d node_modules ] && [ ! -L node_modules ]; then
  fail "node_modules est un vrai dossier : supprimez-le (rm -rf node_modules), réactivez l'environnement Node, puis relancez."
fi
[ -f .env ] || fail ".env absent : créez-le (voir SETUP.md, étape 6)."

# ---------- Code ----------
if [ -d .git ]; then
  say "Récupération du code (git pull)"
  git pull --ff-only
fi

# ---------- Dépendances (sans les outils de test) ----------
say "Installation des dépendances"
npm install --omit=dev --no-audit --no-fund

# ---------- Base de données : migrations (elles s'appliquent aussi au démarrage ; ici on voit l'erreur tout de suite) ----------
say "Migrations de la base"
npm run migrate

mkdir -p storage/public storage/private

# ---------- Redémarrage (Passenger surveille tmp/restart.txt) ----------
mkdir -p tmp && touch tmp/restart.txt
say "API à jour. Elle redémarre au prochain appel."
