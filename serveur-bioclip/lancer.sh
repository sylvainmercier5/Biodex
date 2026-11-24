#!/usr/bin/env bash
# Démarre le service BioCLIP et son tunnel Cloudflare s'ils ne tournent pas déjà.
# Appelé par la crontab de sylvain (au démarrage de la machine, puis toutes les 5 minutes) :
# pas besoin de sudo ni de linger.
# Attention : sous cron, $USER est vide. On prend l'utilisateur avec id -un (sinon le test
# « déjà lancé ? » échoue et un nouveau tunnel démarre toutes les 5 minutes : bug du 24/11).
MOI="$(id -un)"
DOSSIER="$HOME/biodex-bioclip"
cd "$DOSSIER" || exit 1

if ! pgrep -u "$MOI" -f "$DOSSIER/biodex-bioclip.py" > /dev/null; then
  nohup nice -n 5 "$DOSSIER/venv/bin/python" "$DOSSIER/biodex-bioclip.py" >> "$DOSSIER/sortie.log" 2>&1 &
fi

# Tunnel : seulement s'il est configuré (tunnel.yml) et si cloudflared est installé.
if [ -f "$DOSSIER/tunnel.yml" ] && command -v cloudflared > /dev/null; then
  if ! pgrep -u "$MOI" -f "$DOSSIER/tunnel.yml" > /dev/null; then
    nohup cloudflared --no-autoupdate --config "$DOSSIER/tunnel.yml" tunnel run >> "$DOSSIER/tunnel.log" 2>&1 &
  fi
fi
