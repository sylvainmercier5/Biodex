#!/usr/bin/env bash
# Démarre le service BioCLIP et son tunnel Cloudflare s'ils ne tournent pas déjà.
# Appelé par la crontab de sylvain (au démarrage de la machine, puis toutes les 5 minutes) :
# pas besoin de sudo ni de linger.
DOSSIER="$HOME/biodex-bioclip"
cd "$DOSSIER" || exit 1

if ! pgrep -u "$USER" -f "$DOSSIER/venv/bin/python $DOSSIER/biodex-bioclip.py" > /dev/null; then
  nohup nice -n 5 "$DOSSIER/venv/bin/python" "$DOSSIER/biodex-bioclip.py" >> "$DOSSIER/sortie.log" 2>&1 &
fi

# Tunnel : seulement s'il est configuré (tunnel.yml) et si cloudflared est installé.
if [ -f "$DOSSIER/tunnel.yml" ] && command -v cloudflared > /dev/null; then
  if ! pgrep -u "$USER" -f "cloudflared .*--config $DOSSIER/tunnel.yml" > /dev/null; then
    nohup cloudflared --no-autoupdate --config "$DOSSIER/tunnel.yml" tunnel run >> "$DOSSIER/tunnel.log" 2>&1 &
  fi
fi
