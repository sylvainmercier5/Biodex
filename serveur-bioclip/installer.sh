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
"$DOSSIER/venv/bin/pip" install --quiet torch --index-url https://download.pytorch.org/whl/cpu
"$DOSSIER/venv/bin/pip" install --quiet open_clip_torch pillow numpy huggingface_hub

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

echo "== Service systemd (utilisateur)"
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/biodex-bioclip.service" <<EOF
[Unit]
Description=BioDex BioCLIP (identification d'insectes)
After=network-online.target

[Service]
ExecStart=$DOSSIER/venv/bin/python $DOSSIER/biodex-bioclip.py
Restart=always
RestartSec=10
Nice=5
MemoryMax=3500M

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now biodex-bioclip.service
sleep 3
systemctl --user --no-pager status biodex-bioclip.service | head -5 || true

echo
echo "== Reste à faire, avec sudo (à taper toi-même) :"
echo "  sudo loginctl enable-linger $USER          # le service tourne même sans session ouverte"
echo "  sudo tailscale funnel --bg --https=10000 http://127.0.0.1:8192"
echo "Ensuite : curl -s http://127.0.0.1:8192/etat"
