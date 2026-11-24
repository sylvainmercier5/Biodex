// Essai de la nouvelle règle de rareté sur l'échantillon de mesurer-rarete.mjs :
// observations iNaturalist en FRANCE (vérifiables) de l'espèce, plafonnées par celles de son
// genre (un insecte peu photographié d'un genre très vu est surtout difficile à identifier,
// pas rare). Usage : node outils/mesurer-rarete-v2.mjs (après mesurer-rarete.mjs)
import fs from "node:fs";

const avant = JSON.parse(fs.readFileSync("outils/resultats/rarete-mesure.json", "utf8"));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (url) => { const r = await fetch(url, { headers: { "User-Agent": "biodex-mesure-rarete" } }); if (!r.ok) throw new Error(r.status); return r.json(); };
const nbFrance = async (id) => (await api(`https://api.inaturalist.org/v1/observations?taxon_id=${id}&place_id=6753&verifiable=true&per_page=0`)).total_results;

// Seuils proposés (observations en France)
const SEUILS = { commune: 5000, peuCommune: 1000, rare: 200 };
const palier = (n) => (n >= SEUILS.commune ? 0 : n >= SEUILS.peuCommune ? 1 : n >= SEUILS.rare ? 2 : 3);
const NOMS = ["Commun", "Peu commun", "Rare", "Légendaire"];

const sortie = [];
for (const e of avant) {
  try {
    const d = await api("https://api.inaturalist.org/v1/taxa/autocomplete?per_page=10&q=" + encodeURIComponent(e.nom));
    const t = (d.results || []).find((x) => x.name.toLowerCase() === e.nom.toLowerCase());
    await pause(1100);
    if (!t) { console.log(e.nom.padEnd(28), "pas de correspondance exacte"); continue; }
    const fr = await nbFrance(t.id); await pause(1100);
    const parent = t.ancestor_ids[t.ancestor_ids.length - 2];
    const frGenre = await nbFrance(parent); await pause(1100);
    const pEsp = palier(fr), pGenre = palier(frGenre);
    const p = Math.min(pEsp, pGenre + 1); // au plus un cran au-dessus du genre
    sortie.push({ ...e, franceEsp: fr, franceGenre: frGenre, nouveau: NOMS[p], ancien: e.palierCarte });
    console.log([e.nom.padEnd(28), String(fr).padStart(6), String(frGenre).padStart(7), e.palierCarte.padEnd(11), "→", NOMS[p]].join("  "));
  } catch (err) { console.log(e.nom, "échec", err.message); await pause(2000); }
}
fs.writeFileSync("outils/resultats/rarete-mesure-v2.json", JSON.stringify(sortie, null, 1));
const compte = (k) => Object.fromEntries(NOMS.map((n) => [n, sortie.filter((x) => x[k] === n).length]));
console.log("avant", compte("ancien"), "\naprès", compte("nouveau"));
