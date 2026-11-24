#!/usr/bin/env bash
# Installe le service BioCLIP de BioDex sur spotyserbe (utilisateur sylvain, sans sudo).
# À lancer depuis le dossier où se trouvent biodex-bioclip.py, listes/ et noms-fr.json.
#   bash installer.sh
# Ce qui demande sudo (lingering systemd, Tailscale Funnel) est affiché à la fin : tu le tapes toi-même.
set -euo pipefail

ICI="$(cd "$(dirname "$0")" && pwd)"
DOSSIER="$HOME/biodex-bioclip"
mkdir -p "$DOSSIER/listes" "$DOSSIER/hf"

echo "== Fichiers"
cp "$ICI/biodex-bioclip.py" "$DOSSIER/"
cp "$ICI"/listes/*.json "$ICI"/listes/*.npy "$DOSSIER/listes/"
[ -f "$ICI/noms-fr.json" ] && cp "$ICI/noms-fr.json" "$DOSSIER/"

echo "== Environnement Python (torch version processeur, sans carte graphique)"
if [ ! -x "$DOSSIER/venv/bin/python" ]; then
  python3 -m venv "$DOSSIER/venv"
fi
"$DOSSIER/venv/bin/pip" install --quiet --upgrade pip
# torch ET torchvision depuis la même source (processeur) : sinon open_clip tire un torchvision
# incompatible (« operator torchvision::nms does not exist »).
"$DOSSIER/venv/bin/pip" install --quiet torch torchvision --index-url https://download.pytorch.org/whl/cpu
"$DOSSIER/venv/bin/pip" install --quiet open_clip_torch pillow numpy huggingface_hub
"$DOSSIER/venv/bin/python" -c "import torch, torchvision; print('torch', torch.__version__, '/ torchvision', torchvision.__version__)"

echo "== Poids de BioCLIP 2 (une seule fois, environ 1,7 Go)"
HF_HOME="$DOSSIER/hf" HF_HUB_OFFLINE=0 "$DOSSIER/venv/bin/python" -c \
  "import open_clip; open_clip.create_model_and_transforms('hf-hub:imageomics/bioclip-2'); print('poids en cache')"

echo "== Secret partagé avec BioDex"
if [ ! -f "$DOSSIER/secret" ]; then
  "$DOSSIER/venv/bin/python" -c "import secrets; print(secrets.token_hex(32))" > "$DOSSIER/secret"
  chmod 600 "$DOSSIER/secret"
  echo "secret créé dans $DOSSIER/secret"
else
  echo "secret déjà présent, conservé"
fi

# Démarrage par la crontab de l'utilisateur, sans sudo : un service systemd « --user »
# s'arrête à la fin de chaque session tant que « linger » (qui demande sudo) n'est pas activé.
echo "== Démarrage automatique (crontab)"
cp "$ICI/lancer.sh" "$DOSSIER/" && chmod +x "$DOSSIER/lancer.sh"
[ -f "$ICI/tunnel.yml" ] && cp "$ICI/tunnel.yml" "$DOSSIER/"
( crontab -l 2>/dev/null | grep -v 'biodex-bioclip/lancer.sh'
  echo "@reboot sleep 60 && $DOSSIER/lancer.sh"
  echo "*/5 * * * * $DOSSIER/lancer.sh"
) | crontab -
"$DOSSIER/lancer.sh"
sleep 15
curl -s http://127.0.0.1:8192/etat; echo

echo
echo "== Ouverture à BioDex : tunnel Cloudflare dédié (voir INSTALLATION.md, section 3)"
