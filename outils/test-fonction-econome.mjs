// Teste la VRAIE fonction Netlify (netlify/functions/identifier.js) en local, avec la formule
// économe, sur les photos de l'essai BioCLIP. Le service BioCLIP doit tourner (BIOCLIP_URL).
// Usage : node outils/test-fonction-econome.mjs [nbMax] [zone]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ESSAI = "C:/Goupil/naturaliste/essai";
process.env.ANTHROPIC_API_KEY = fs.readFileSync(path.join(os.homedir(), ".biodex", "cle-anthropic.txt"), "utf8").trim();
process.env.BIOCLIP_URL = process.env.BIOCLIP_URL || "http://127.0.0.1:8192";
process.env.BIOCLIP_CLE = process.env.BIOCLIP_CLE || fs.readFileSync(path.join(os.homedir(), "biodex-bioclip", "secret"), "utf8").trim();
const { handler } = require("../netlify/functions/identifier.js");

const nbMax = Number(process.argv[2] || 999);
const zone = process.argv[3] || "limousin";
const meta = JSON.parse(fs.readFileSync(`${ESSAI}/metadonnees.json`, "utf8")).slice(0, nbMax);
const binome = (s) => String(s || "").trim().toLowerCase().split(/\s+/).slice(0, 2).join(" ");
const sortie = new URL("./resultats/fonction-econome.json", import.meta.url);
const res = [];
let i = 0;
for (const m of meta) {
  const image = fs.readFileSync(`${ESSAI}/photos/${m.fichier}`).toString("base64");
  const t0 = Date.now();
  const r = await handler({
    httpMethod: "POST",
    headers: { "x-nf-client-connection-ip": "10.0.0." + (i++ % 250) },
    body: JSON.stringify({ mode: "identification", image, media_type: "image/jpeg", contexte: { region: "centre de la France", zone } }),
  });
  const d = JSON.parse(r.body);
  const x = d.resultat || {};
  const ok = binome(x.nomSci) === binome(m.espece);
  res.push({ f: m.fichier, vrai: m.espece, statut: r.statusCode, source: d.source, nomSci: x.nomSci, nom: x.nom, confiance: x.confiance,
    contact: x.contact, role: x.role, ok, ms: Date.now() - t0, erreur: d.erreur });
  console.log(`${String(r.statusCode).padEnd(4)} ${String(d.source).padEnd(15)} ${ok ? "✓" : "✗"} ${String(x.nomSci).padEnd(30)} ${String(x.nom || "").padEnd(28)} ${x.contact || ""}  ${Date.now() - t0} ms${d.erreur ? "  " + d.erreur : ""}`);
  fs.writeFileSync(sortie, JSON.stringify(res, null, 1));
}
const pc = (f, l = res) => l.length ? Math.round(100 * l.filter(f).length / l.length) + " %" : "-";
console.log(`\n${res.length} photos | bonne espèce ${pc((x) => x.ok)} | HTTP 200 ${pc((x) => x.statut === 200)}`);
for (const s of ["bioclip", "claude+bioclip", "claude"]) {
  const l = res.filter((x) => x.source === s);
  if (l.length) console.log(`  ${s.padEnd(15)} ${l.length} photos, juste ${pc((x) => x.ok, l)}, ${Math.round(l.reduce((a, x) => a + x.ms, 0) / l.length)} ms en moyenne, max ${Math.max(...l.map((x) => x.ms))} ms`);
}
