# -*- coding: utf-8 -*-
"""BioDex BioCLIP : le service d'identification d'insectes de spotyserbe (le ProDesk).

Adapté du service « Goupil naturaliste » (C:\\Goupil\\goupil\\deploiement\\pc-gaming\\goupil-naturaliste.py) :
même modèle, mêmes listes, même calcul que l'essai du 23 novembre 2026. Différences :
  - Linux, processeur seulement (pas de carte graphique sur spotyserbe) ;
  - appelé par la fonction Netlify de BioDex à travers Tailscale Funnel : chaque demande doit porter
    l'en-tête « X-BioDex-Cle » égal au secret du fichier ~/biodex-bioclip/secret (sinon 401) ;
  - modèle gardé en mémoire (le recharger sur ce processeur prendrait trop de temps pour BioDex),
    sauf si --decharge N est donné (minutes sans demande avant de libérer la mémoire).

  POST /identifier  {"image": "<base64 JPEG/PNG/WebP>", "liste": "limousin" | "france"}  ->  top 5, rangs, verdict
  GET  /etat        {"ok": true, "charge": bool, ...}   (sans secret : ne dit rien de sensible)

Écoute sur 127.0.0.1 seulement : seul Tailscale (serve / funnel) le relaie. Aucune image n'est gardée.
"""
import base64
import binascii
import gc
import heapq
import hmac
import io
import json
import math
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DOSSIER = os.path.expanduser("~/biodex-bioclip")
os.environ.setdefault("HF_HOME", os.path.join(DOSSIER, "hf"))
os.environ.setdefault("HF_HUB_OFFLINE", "1")

VERSION = "1.0.0"
HOTE = "127.0.0.1"
PORT = 8192
JOURNAL = os.path.join(DOSSIER, "journal.log")
FICHIER_SECRET = os.path.join(DOSSIER, "secret")

IMAGE_MAX = 12 * 1024 * 1024
CORPS_MAX = 17_000_000
DRAIN_MAX = 64 * 1024 * 1024
SEUIL_VERDICT = 0.8
SEUIL_REPLI = 0.3                     # liste Limousin : si la meilleure espèce a moins de 30 %, on réessaie avec la France
EPSILON = 1e-9
ATTENTE_VERROU_S = 20                 # BioDex attend au plus ~25 s : inutile de faire patienter plus
FILS = 3                              # 3 cœurs sur 4 : on en laisse un à Goupil
LISTES = ("limousin", "france")
RANGS = (("classe", 0), ("ordre", 1), ("famille", 2), ("genre", 3))


class ErreurClient(Exception):
    code = 400


class ErreurService(Exception):
    def __init__(self, message, code=500):
        super().__init__(message)
        self.code = code


class ImageIllisible(ErreurClient):
    pass


class Journal:
    def __init__(self, chemin=JOURNAL, taille_max=2_000_000):
        self.chemin = chemin
        self.taille_max = taille_max
        self._verrou = threading.Lock()

    def ecrire(self, texte):
        ligne = "%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), str(texte).replace("\r", " ").replace("\n", " | "))
        with self._verrou:
            try:
                if self.chemin is None:
                    return
                os.makedirs(os.path.dirname(self.chemin), exist_ok=True)
                if os.path.exists(self.chemin) and os.path.getsize(self.chemin) > self.taille_max:
                    os.replace(self.chemin, self.chemin + ".1")
                with open(self.chemin, "a", encoding="utf-8") as f:
                    f.write(ligne)
            except Exception:
                pass


class Liste:
    """taxons[i] = (classe, ordre, famille, genre, "Genre espece"), matrice = textes BioCLIP (N x 768)."""

    def __init__(self, nom, taxons, noms_fr=None, matrice=None):
        self.nom = nom
        self.taxons = taxons
        self.noms_fr = noms_fr or {}
        self.matrice = matrice


def analyser(liste, probas):
    """Probabilités par espèce -> {top, rangs, verdict}. Probabilité d'un rang = somme de celles de ses espèces."""
    n = len(liste.taxons)
    if len(probas) != n or n == 0:
        raise ErreurService("le modèle a rendu %d probabilités pour %d espèces" % (len(probas), n))
    meilleurs = heapq.nlargest(5, range(n), key=lambda i: (probas[i], -i))
    top = []
    for i in meilleurs:
        classe, ordre, famille, genre, espece = liste.taxons[i]
        top.append({"nom": espece, "nom_fr": liste.noms_fr.get(espece, ""), "p": round(min(1.0, probas[i]), 4),
                    "genre": genre, "famille": famille, "ordre": ordre, "classe": classe})
    brut = {}
    for rang, k in RANGS:
        parts = {}
        for i in range(n):
            parts.setdefault(liste.taxons[i][:k + 1], []).append(probas[i])
        meilleur = max(parts.items(), key=lambda kv: (math.fsum(kv[1]), kv[0]))
        brut[rang] = (meilleur[0][-1], min(1.0, math.fsum(meilleur[1])))
    brut["espece"] = (liste.taxons[meilleurs[0]][4], min(1.0, probas[meilleurs[0]]))
    verdict = "rien"
    for rang in ("espece", "genre", "famille", "ordre"):
        if brut[rang][1] >= SEUIL_VERDICT - EPSILON:
            verdict = rang
            break
    rangs = {rang: {"nom": brut[rang][0], "p": round(brut[rang][1], 4)} for rang in ("classe", "ordre", "famille", "genre", "espece")}
    return {"top": top, "rangs": rangs, "verdict": verdict}


class ModeleBioclip:
    def __init__(self):
        self.model = None
        self.preprocess = None
        self._torch = None

    def charger(self):
        import torch
        import open_clip

        self._torch = torch
        torch.set_num_threads(FILS)
        model, _, preprocess = open_clip.create_model_and_transforms("hf-hub:imageomics/bioclip-2")
        model.eval()
        self.model, self.preprocess = model.float(), preprocess

    def decharger(self):
        self.model = None
        self.preprocess = None
        gc.collect()

    def encoder(self, octets):
        from PIL import Image, ImageOps

        try:
            Image.MAX_IMAGE_PIXELS = 100_000_000
            im = Image.open(io.BytesIO(octets))
            im.load()
            im = ImageOps.exif_transpose(im).convert("RGB")
        except Exception as e:
            raise ImageIllisible("l'image est illisible (%s)" % type(e).__name__)
        torch = self._torch
        x = self.preprocess(im).unsqueeze(0).float()
        with torch.no_grad():
            f = self.model.encode_image(x)
            f = torch.nn.functional.normalize(f.float(), dim=-1)
        return f[0].numpy()

    def probabilites(self, features, liste):
        import numpy as np

        logits = (liste.matrice @ features) * 100.0  # logit_scale de BioCLIP 2
        logits -= logits.max()
        e = np.exp(logits)
        return (e / e.sum()).tolist()


class ChargeurListes:
    """Lit listes/<nom>.json + listes/<nom>.npy (copiés depuis le PC, construits par le service de Goupil)."""

    def __init__(self, dossier=DOSSIER):
        self.dossier = dossier

    def noms_fr(self):
        try:
            with open(os.path.join(self.dossier, "noms-fr.json"), encoding="utf-8") as f:
                d = json.load(f)
            return {str(k): str(v) for k, v in d.items() if isinstance(v, str)}
        except Exception:
            return {}

    def obtenir(self, nom):
        import numpy as np

        base = os.path.join(self.dossier, "listes", nom)
        try:
            with open(base + ".json", encoding="utf-8") as f:
                taxons = [tuple(t) for t in json.load(f)["taxons"]]
            matrice = np.load(base + ".npy").astype(np.float32)
        except Exception as e:
            raise ErreurService("la liste « %s » est illisible (%s)" % (nom, type(e).__name__), 503)
        if matrice.shape[0] != len(taxons):
            raise ErreurService("la liste « %s » est incohérente" % nom, 503)
        return Liste(nom, taxons, self.noms_fr(), matrice)


class Identificateur:
    def __init__(self, modele, fournisseur, journal=None, delai_decharge=0, horloge=time.monotonic):
        self.modele = modele
        self.fournisseur = fournisseur
        self.journal = journal or Journal(None)
        self.delai_decharge = delai_decharge
        self.horloge = horloge
        self._verrou = threading.Lock()
        self._listes = {}
        self.charge = False
        self._derniere = horloge()
        self.compteur = 0

    def etat(self):
        return {"ok": True, "charge": bool(self.charge), "version": VERSION, "identifications": self.compteur}

    def _charger(self):
        if self.charge:
            return
        t = time.time()
        try:
            self.modele.charger()
        except Exception as e:
            self.journal.ecrire("ÉCHEC du chargement de BioCLIP 2 : %s: %s" % (type(e).__name__, str(e)[:300]))
            raise ErreurService("BioCLIP 2 n'a pas pu être chargé (%s)" % type(e).__name__, 503)
        self.charge = True
        self.journal.ecrire("BioCLIP 2 chargé en %.1f s" % (time.time() - t))

    def _liste(self, nom):
        if nom not in self._listes:
            self._listes[nom] = self.fournisseur(nom)
        return self._listes[nom]

    def _calculer(self, features, nom):
        liste = self._liste(nom)
        return analyser(liste, self.modele.probabilites(features, liste))

    def prechauffer(self):
        with self._verrou:
            self._charger()
            for nom in LISTES:
                self._liste(nom)

    def identifier(self, octets, nom_liste="france"):
        if nom_liste not in LISTES:
            raise ErreurClient("liste inconnue : limousin ou france")
        if not self._verrou.acquire(timeout=ATTENTE_VERROU_S):
            raise ErreurService("le service est occupé, réessaie dans un instant", 503)
        try:
            debut = time.time()
            self._charger()
            features = self.modele.encoder(octets)
            utilisee, repli = nom_liste, False
            res = self._calculer(features, utilisee)
            if utilisee == "limousin" and res["top"][0]["p"] < SEUIL_REPLI:
                utilisee, repli = "france", True
                res = self._calculer(features, utilisee)
            ms = int(round((time.time() - debut) * 1000))
            self._derniere = self.horloge()
            self.compteur += 1
            self.journal.ecrire("identifié : %s%s, %s p=%.2f, verdict %s, %d ms, image %d Ko" % (
                utilisee, " (repli)" if repli else "", res["top"][0]["nom"], res["top"][0]["p"], res["verdict"], ms, len(octets) // 1024))
            return {"ok": True, "liste": utilisee, "ms": ms, "top": res["top"], "rangs": res["rangs"], "verdict": res["verdict"], "repli": repli}
        finally:
            self._verrou.release()

    def verifier_decharge(self):
        if not self.delai_decharge or not self.charge or self.horloge() - self._derniere < self.delai_decharge:
            return False
        if not self._verrou.acquire(blocking=False):
            return False
        try:
            self.modele.decharger()
            self._listes.clear()
            self.charge = False
            self.journal.ecrire("BioCLIP 2 déchargé (pas de demande depuis %d min)" % (self.delai_decharge // 60))
            return True
        finally:
            self._verrou.release()


def decoder_image(valeur):
    if not isinstance(valeur, str) or not valeur.strip():
        raise ErreurClient("il manque le champ « image » (base64 d'un JPEG, PNG ou WebP)")
    valeur = re.sub(r"^\s*data:[^,]*;base64,", "", valeur).strip()
    if len(valeur) > IMAGE_MAX * 4 // 3 + 16:
        raise ErreurClient("image trop lourde : 12 Mo au plus")
    try:
        octets = base64.b64decode(valeur, validate=True)
    except (binascii.Error, ValueError):
        raise ErreurClient("le champ « image » n'est pas du base64 valide")
    if octets[:3] == b"\xff\xd8\xff" or octets[:8] == b"\x89PNG\r\n\x1a\n" or (octets[:4] == b"RIFF" and octets[8:12] == b"WEBP"):
        return octets
    raise ErreurClient("format d'image non reconnu : JPEG, PNG ou WebP seulement")


def lire_secret(chemin=FICHIER_SECRET):
    with open(chemin, encoding="utf-8") as f:
        s = f.read().strip()
    if len(s) < 32:
        raise SystemExit("secret trop court dans %s (32 caractères au moins)" % chemin)
    return s


class Gestionnaire(BaseHTTPRequestHandler):
    server_version = "BioDexBioclip/" + VERSION
    timeout = 60

    def log_message(self, fmt, *args):
        pass

    def _repondre(self, code, corps):
        octets = json.dumps(corps, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(octets)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(octets)

    def _erreur(self, code, message):
        self._repondre(code, {"ok": False, "erreur": message})

    def _local(self):
        # Tailscale serve/funnel relaie depuis la machine elle-même : rien d'autre ne doit arriver ici.
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            self._erreur(403, "connexion locale seulement")
            return False
        return True

    def _vider_corps(self, longueur):
        reste = min(max(longueur, 0), DRAIN_MAX)
        try:
            while reste > 0:
                morceau = self.rfile.read(min(65536, reste))
                if not morceau:
                    break
                reste -= len(morceau)
        except Exception:
            pass

    def do_GET(self):
        if not self._local():
            return
        if self.path.split("?", 1)[0] == "/etat":
            return self._repondre(200, self.server.identificateur.etat())
        self._erreur(404, "inconnu")

    def do_POST(self):
        self.close_connection = True
        if not self._local():
            return
        try:
            longueur = int(self.headers.get("Content-Length") or "-1")
        except ValueError:
            longueur = -1
        if self.path.split("?", 1)[0] != "/identifier":
            self._vider_corps(longueur)
            return self._erreur(404, "inconnu")
        cle = self.headers.get("X-BioDex-Cle") or ""
        if not hmac.compare_digest(cle.encode("utf-8"), self.server.secret.encode("utf-8")):
            self._vider_corps(longueur)
            self.server.journal.ecrire("refusé (401) : clé absente ou fausse")
            return self._erreur(401, "clé absente ou fausse")
        if longueur < 0:
            return self._erreur(400, "il manque Content-Length")
        if longueur > CORPS_MAX:
            self._vider_corps(longueur)
            return self._erreur(400, "image trop lourde : 12 Mo au plus")
        corps = self.rfile.read(longueur) if longueur else b""
        try:
            donnees = json.loads(corps.decode("utf-8"))
            if not isinstance(donnees, dict):
                raise ValueError
        except (ValueError, UnicodeDecodeError):
            return self._erreur(400, "le corps n'est pas un objet JSON")
        try:
            nom_liste = donnees.get("liste") or "france"
            if not isinstance(nom_liste, str) or nom_liste not in LISTES:
                raise ErreurClient("liste inconnue : limousin ou france")
            resultat = self.server.identificateur.identifier(decoder_image(donnees.get("image")), nom_liste)
        except ErreurClient as e:
            return self._erreur(400, str(e))
        except ErreurService as e:
            self.server.journal.ecrire("erreur (%d) : %s" % (e.code, e))
            return self._erreur(e.code, str(e))
        except Exception as e:
            self.server.journal.ecrire("ERREUR inattendue : %s: %s" % (type(e).__name__, str(e)[:300]))
            return self._erreur(500, "erreur interne (%s)" % type(e).__name__)
        self._repondre(200, resultat)


class Serveur(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, adresse, identificateur, journal, secret):
        self.identificateur = identificateur
        self.journal = journal
        self.secret = secret
        super().__init__(adresse, Gestionnaire)


def boucle_decharge(identificateur, pas=30):
    while True:
        time.sleep(pas)
        try:
            identificateur.verifier_decharge()
        except Exception:
            pass


def principal(argv):
    port = int(argv[argv.index("--port") + 1]) if "--port" in argv else PORT
    decharge_min = int(argv[argv.index("--decharge") + 1]) if "--decharge" in argv else 0
    journal = Journal()
    secret = lire_secret()
    identificateur = Identificateur(ModeleBioclip(), ChargeurListes().obtenir, journal, delai_decharge=decharge_min * 60)
    serveur = Serveur((HOTE, port), identificateur, journal, secret)
    journal.ecrire("service %s démarré sur %s:%d (pid %d)" % (VERSION, HOTE, port, os.getpid()))
    if not decharge_min:
        threading.Thread(target=identificateur.prechauffer, daemon=True).start()
    else:
        threading.Thread(target=boucle_decharge, args=(identificateur,), daemon=True).start()
    try:
        serveur.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        journal.ecrire("service arrêté")
    return 0


if __name__ == "__main__":
    sys.exit(principal(sys.argv[1:]))
