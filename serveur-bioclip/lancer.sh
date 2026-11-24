#!/usr/bin/env bash
# Démarre le service BioCLIP s'il ne tourne pas déjà. Appelé par la crontab de sylvain
# (au démarrage de la machine, puis toutes les 5 minutes) : pas besoin de sudo ni de linger.
DOSSIER="$HOME/biodex-bioclip"
if pgrep -u "$USER" -f "$DOSSIER/biodex-bioclip.py" > /dev/null; then
  exit 0
fi
cd "$DOSSIER" || exit 1
nohup nice -n 5 "$DOSSIER/venv/bin/python" "$DOSSIER/biodex-bioclip.py" >> "$DOSSIER/sortie.log" 2>&1 &
