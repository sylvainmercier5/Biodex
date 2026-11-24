// Mesure la logique de rareté de BioDex sur un échantillon d'espèces du Limousin.
// Pour chaque espèce : observations MONDIALES iNaturalist (ce qu'utilise l'appli aujourd'hui),
// observations en FRANCE (place_id 6753) et dans le LIMOUSIN (fichier Goupil), puis le palier
// que l'appli donne aujourd'hui. Sortie : outils/resultats/rarete-mesure.json + tableau.
// Usage : node outils/mesurer-rarete.mjs
import fs from "node:fs";

const local = JSON.parse(fs.readFileSync("C:/Goupil/naturaliste/essai/limousin_insectes_inat.json", "utf8"))
  .filter((x) => x.rang === "species");
local.sort((a, b) => b.n - a.n);
const pris = new Set();
const echantillon = [];
const prendre = (x) => { if (x && !pris.has(x.nom)) { pris.add(x.nom); echantillon.push(x); } };
local.slice(0, 15).forEach(prendre);                                   // les plus vues localement
local.filter((x) => x.n >= 8 && x.n <= 30).filter((_, i) => i % 9 === 0).slice(0, 12).forEach(prendre); // moyennes
local.filter((x) => x.n <= 2).filter((_, i) => i % 60 === 0).slice(0, 12).forEach(prendre);           // rarement vues
// Cas connus (communs discrets, raretés patrimoniales)
["Musca domestica", "Episyrphus balteatus", "Apis mellifera", "Bombus terrestris", "Pieris rapae", "Coccinella septempunctata",
 "Harmonia axyridis", "Rosalia alpina", "Osmoderma eremita", "Cerambyx cerdo", "Morimus asper", "Euplagia quadripunctaria",
 "Lucanus cervus", "Cetonia aurata", "Graphosoma italicum", "Pyrrhocoris apterus", "Ichneumon stramentor", "Sarcophaga carnaria"]
  .forEach((nom) => prendre(local.find((x) => x.nom === nom) || { nom, n: null }));

const S = { tresRare: 2000, rare: 20000, peuCommune: 80000 };
function rareteDepuisCount(count) {
  const lc = Math.log10(Math.max(1, count));
  const seg = (loMin, loMax, rMin, rMax) => { const t = Math.min(1, Math.max(0, (lc - loMin) / (loMax - loMin))); return Math.round(rMax - t * (rMax - rMin)); };
  if (count < S.tresRare) return seg(1, Math.log10(S.tresRare), 85, 100);
  if (count < S.rare) return seg(Math.log10(S.tresRare), Math.log10(S.rare), 65, 84);
  if (count < S.peuCommune) return seg(Math.log10(S.rare), Math.log10(S.peuCommune), 45, 64);
  return seg(Math.log10(S.peuCommune), 7, 15, 44);
}
const palier = (v) => (v >= 85 ? "Légendaire" : v >= 65 ? "Rare" : v >= 40 ? "Peu commun" : "Commun");
const niveau = (c) => (c < S.tresRare ? "Très rare" : c < S.rare ? "Rare" : c < S.peuCommune ? "Peu commune" : "Commune");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (url) => { const r = await fetch(url, { headers: { "User-Agent": "biodex-mesure-rarete" } }); if (!r.ok) throw new Error(r.status); return r.json(); };

const sortie = [];
for (const e of echantillon) {
  try {
    const d = await api("https://api.inaturalist.org/v1/taxa/autocomplete?per_page=5&q=" + encodeURIComponent(e.nom));
    const t = (d.results || []).find((x) => x.name.toLowerCase() === e.nom.toLowerCase()) || (d.results || [])[0];
    await pause(1100);
    const f = await api(`https://api.inaturalist.org/v1/observations?taxon_id=${t.id}&place_id=6753&verifiable=true&per_page=0`);
    await pause(1100);
    const monde = t.observations_count;
    const v = rareteDepuisCount(monde);
    const ligne = { nom: e.nom, fr: t.preferred_common_name || "", limousin: e.n, france: f.total_results, monde, niveauObs: niveau(monde), rareteCarte: v, palierCarte: palier(v) };
    sortie.push(ligne);
    console.log([ligne.nom.padEnd(28), String(ligne.limousin ?? "-").padStart(4), String(ligne.france).padStart(7), String(monde).padStart(8), ligne.niveauObs.padEnd(12), String(v).padStart(3), ligne.palierCarte].join("  "));
  } catch (err) { console.log(e.nom, "échec", err.message); await pause(2000); }
}
fs.mkdirSync("outils/resultats", { recursive: true });
fs.writeFileSync("outils/resultats/rarete-mesure.json", JSON.stringify(sortie, null, 1));
