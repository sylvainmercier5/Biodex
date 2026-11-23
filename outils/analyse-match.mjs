// Analyse du match : Claude (actuel / corrigé) face à BioCLIP, photo par photo.
// Usage : node outils/analyse-match.mjs
import fs from "node:fs";

const ESSAI = "C:/Goupil/naturaliste/essai";
const res = JSON.parse(fs.readFileSync(new URL("./resultats/match.json", import.meta.url), "utf8"));
const meta = JSON.parse(fs.readFileSync(`${ESSAI}/metadonnees.json`, "utf8"));
const annot = JSON.parse(fs.readFileSync(`${ESSAI}/annotations.json`, "utf8"));
const bio = JSON.parse(fs.readFileSync(`${ESSAI}/resultats_bruts.json`, "utf8")).photos;

const bioDe = (liste, f) => bio.find((x) => x.liste === liste && x.prep === "oc" && x.fichier === f);
const lignes = meta.map((m) => {
  const a = res[`actuel|${m.fichier}`] || {}, c = res[`corrige|${m.fichier}`] || {};
  const bl = bioDe("limousin", m.fichier), bf = bioDe("france", m.fichier);
  return {
    f: m.fichier, vrai: m.espece, type: (annot[m.fichier] || {}).type || "?",
    actuel: a, corrige: c,
    bioL: bl && { sci: bl.espece.top[0], p: bl.espece.p[0], ok: bl.espece.top[0] === m.espece, genre_ok: bl.genre.top[0] === bl.genre.vrai, top3: bl.espece.top.slice(0, 3).includes(m.espece) },
    bioF: bf && { sci: bf.espece.top[0], p: bf.espece.p[0], ok: bf.espece.top[0] === m.espece, genre_ok: bf.genre.top[0] === bf.genre.vrai },
  };
}).filter((l) => l.actuel.nomSci !== undefined || l.corrige.nomSci !== undefined);

const pc = (l, f) => l.length ? Math.round(100 * l.filter(f).length / l.length) + " %" : "-";
const n = lignes.length;
console.log(`\n=== ${n} photos analysées ===\n`);
const systemes = [
  ["BioDex actuel (Opus 4.8)", (l) => l.actuel.espece_ok, (l) => l.actuel.genre_ok],
  ["BioDex corrigé (Opus 5.5)", (l) => l.corrige.espece_ok, (l) => l.corrige.genre_ok],
  ["BioCLIP liste Limousin", (l) => l.bioL && l.bioL.ok, (l) => l.bioL && l.bioL.genre_ok],
  ["BioCLIP liste France", (l) => l.bioF && l.bioF.ok, (l) => l.bioF && l.bioF.genre_ok],
];
console.log("Système".padEnd(28), "Espèce".padEnd(8), "Genre".padEnd(8), "Gros plans".padEnd(11), "Terrain");
for (const [nom, esp, gen] of systemes) {
  console.log(nom.padEnd(28), pc(lignes, esp).padEnd(8), pc(lignes, gen).padEnd(8),
    pc(lignes.filter((l) => l.type === "gros_plan"), esp).padEnd(11), pc(lignes.filter((l) => l.type === "terrain"), esp));
}

// Calibration de Claude : quand il se dit sûr (≥ 80), a-t-il raison ?
for (const v of ["actuel", "corrige"]) {
  const surs = lignes.filter((l) => (l[v].res || {}).confiance >= 80);
  console.log(`\n${v} : se dit sûr (≥ 80) sur ${surs.length}/${n} photos, juste ${pc(surs, (l) => l[v].espece_ok)} du temps`);
  const niveaux = {};
  lignes.forEach((l) => { const k = (l[v].res || {}).niveau || "?"; niveaux[k] = (niveaux[k] || 0) + 1; });
  console.log(`  niveau annoncé :`, JSON.stringify(niveaux));
}

// Duo : BioCLIP propose (liste Limousin), Claude corrigé arbitre — estimation simple
const duo = lignes.filter((l) => l.bioL).map((l) => (l.bioL.p >= 0.8 ? l.bioL.ok : l.corrige.espece_ok));
console.log(`\nDuo « BioCLIP si p ≥ 0,8, sinon Claude corrigé » : ${Math.round(100 * duo.filter(Boolean).length / duo.length)} %`);
const unDesDeux = lignes.filter((l) => l.bioL && (l.bioL.ok || l.corrige.espece_ok)).length;
console.log(`Au moins l'un des deux juste (plafond d'un duo parfait) : ${Math.round(100 * unDesDeux / n)} %`);

// Coût et vitesse
for (const v of ["actuel", "corrige"]) {
  const ok = lignes.map((l) => l[v]).filter((x) => x.cout !== undefined);
  const cout = ok.reduce((a, x) => a + x.cout, 0);
  console.log(`\n${v} : ${(cout / ok.length * 100).toFixed(2)} centimes/photo, ${Math.round(ok.reduce((a, x) => a + x.ms, 0) / ok.length / 100) / 10} s/photo, ${Math.round(ok.reduce((a, x) => a + (x.sortie || 0), 0) / ok.length)} jetons de sortie`);
}

// Erreurs détaillées
console.log("\n=== Erreurs à l'espèce (vrai → actuel | corrigé | BioCLIP Limousin) ===");
for (const l of lignes.filter((l) => !l.actuel.espece_ok || !l.corrige.espece_ok || !(l.bioL && l.bioL.ok))) {
  const m = (ok, s) => (ok ? "✓" : "✗ " + (s || "?"));
  console.log(`${l.vrai.padEnd(28)} [${l.type}]  ${m(l.actuel.espece_ok, l.actuel.nomSci).padEnd(30)} | ${m(l.corrige.espece_ok, l.corrige.nomSci).padEnd(30)} | ${m(l.bioL && l.bioL.ok, l.bioL && l.bioL.sci)}`);
}
