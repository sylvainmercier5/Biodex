# BioCLIP sur spotyserbe : installation

Le service `biodex-bioclip.py` reconnaît l'espèce sur la photo, avec BioCLIP 2 (modèle spécialisé dans le vivant, licence MIT). La fonction Netlify de BioDex l'appelle avant Claude. C'est la formule « économe » :
- **BioCLIP sûr** (probabilité ≥ 80 %) : son espèce est retenue, et Haiku complète la fiche sans photo (nom français, rôle, danger au contact).
- **BioCLIP hésitant** : Claude Opus 5.5 regarde la photo et tranche, avec les 5 candidats de BioCLIP en indice.
- **BioCLIP injoignable, hors de France, ou non configuré** : Claude seul, comme avant. BioDex ne tombe jamais en panne à cause de spotyserbe.

Mesures du 24/11/2026 sur 123 photos iNaturalist : voir `outils/` et le rapport en bas de ce fichier.

## 1. Accès SSH (une seule fois, à faire toi-même)

Sur le PC (theserbebeast), dans PowerShell, en une seule ligne. Tu tapes le mot de passe de `sylvain` :

```
ssh -o PubkeyAuthentication=no sylvain@spotyserbe "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -q 'claude-biodex@theserbebeast' ~/.ssh/authorized_keys || echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP62DTG9/i29eajDo5zxxG59IU4Z6t5jzEwHSVfHciHN claude-biodex@theserbebeast' >> ~/.ssh/authorized_keys) && echo CLE-AJOUTEE"
```

Ensuite, `ssh spotyserbe` marche sans mot de passe depuis ce PC (clé `~/.ssh/id_ed25519_spotyserbe`, réservée à BioDex). Pour la retirer : supprimer la ligne `claude-biodex@theserbebeast` de `~/.ssh/authorized_keys` sur spotyserbe.

## 2. Copier et installer (Claude peut le faire une fois la clé ajoutée)

Depuis le PC :
```
scp -r serveur-bioclip C:\Goupil\naturaliste\listes C:\Goupil\naturaliste\noms-fr.json spotyserbe:~/biodex-installation/
ssh spotyserbe "cd ~/biodex-installation && mv listes serveur-bioclip/ && mv noms-fr.json serveur-bioclip/ && bash serveur-bioclip/installer.sh"
```

L'installation prend 5 à 15 minutes : torch pour processeur, puis 1,7 Go de poids. Elle n'utilise pas sudo.

**Démarrage automatique :** par la crontab de `sylvain` (`lancer.sh` au démarrage de la machine, puis toutes les 5 minutes s'il s'est arrêté). On n'utilise pas de service systemd `--user`, parce qu'il s'arrêterait à chaque fin de session SSH sans `loginctl enable-linger`, qui demande sudo.

**Mémoire :** le modèle reste chargé en permanence, environ 2,1 Go mesurés le 24/11. Si spotyserbe manque de mémoire, ajoute `--decharge 30` dans `lancer.sh` : la mémoire est libérée après 30 minutes sans demande. Mais alors, la première identification après une pause prendra environ 7 secondes de plus.

**Mesuré sur spotyserbe le 24/11 :** environ 1 seconde par photo, et 7 secondes de chargement au démarrage.

## 3. Ouvrir le service à BioDex (tunnel Cloudflare dédié, sans sudo)

Tailscale Funnel demandait `sudo` (`tailscale set --operator`), donc on a choisi un **tunnel Cloudflare réservé à BioCLIP**, créé le 24/11/2026 par le compte `sylvain` :

```
cloudflared tunnel create biodex-bioclip
cloudflared tunnel route dns biodex-bioclip bioclip.larenardiere87.com
```

- Configuration : `~/biodex-bioclip/tunnel.yml` (copie dans `serveur-bioclip/tunnel.yml`). Seul `POST /identifier` est relayé ; tout le reste répond 404, y compris `/etat`.
- Démarré et relancé par `lancer.sh`, depuis la crontab, comme le service. Journal : `~/biodex-bioclip/tunnel.log`.
- Le tunnel de la musique (`musique.larenardiere87.com`, service système `/etc/cloudflared`) n'est pas touché.
- Ni Goupil, ni ComfyUI, ni SearXNG ne sont exposés.

Vérifié depuis Internet le 24/11 :
- `/` et `/etat` répondent 404 ;
- sans le secret, ou avec un faux secret, la réponse est 401 ;
- avec le secret, environ 1,1 s par photo.

Protection : chaque demande doit porter le secret de `~/biodex-bioclip/secret`, sinon le service répond 401. Une seule identification à la fois, 12 Mo par photo au plus, aucune image n'est gardée.

## 4. Brancher BioDex (Netlify → Project configuration → Environment variables)

| Variable | Valeur |
|---|---|
| `BIOCLIP_URL` | `https://bioclip.larenardiere87.com` |
| `BIOCLIP_CLE` | le contenu de `~/biodex-bioclip/secret` sur spotyserbe : `ssh spotyserbe cat ~/biodex-bioclip/secret` (coche « Contains secret values ») |

Puis redéployer. Sans ces deux variables, BioDex marche comme avant (Claude seul).

## 5. Vérifier

- Sur spotyserbe : `curl -s http://127.0.0.1:8192/etat` doit répondre `"charge": true`.
- Journal : `~/biodex-bioclip/journal.log` (une ligne par identification : espèce, probabilité, durée).
- Dans les journaux de la fonction Netlify, chaque identification affiche `identification : bioclip`, `claude+bioclip` ou `claude`.

## Retirer

```
crontab -l | grep -v biodex-bioclip/lancer.sh | crontab -
pkill -f biodex-bioclip/tunnel.yml
pkill -f biodex-bioclip.py
cloudflared tunnel delete biodex-bioclip
# puis supprimer l'enregistrement DNS « bioclip » dans le tableau de bord Cloudflare
rm -rf ~/biodex-bioclip
```
Et supprimer `BIOCLIP_URL` et `BIOCLIP_CLE` dans Netlify.
