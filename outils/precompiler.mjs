// Précompile BioDex pour la publication (Netlify : « npm run build », publie dist/).
//
// Avant : le téléphone téléchargeait Babel (~3 Mo une fois décompressé) puis traduisait
// 14 000 lignes de JSX à CHAQUE ouverture. Maintenant la traduction est faite une seule
// fois, ici, avec la MÊME version de Babel et le MÊME réglage (preset « react ») que le
// navigateur : le code exécuté est identique, il arrive juste prêt à l'emploi.
//
// La source reste index.html (on continue de l'éditer tel quel) ; dist/ est généré.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Babel = require("@babel/standalone");

const RACINE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const DIST = path.join(RACINE, "dist");
const lire = (f) => fs.readFileSync(path.join(RACINE, f), "utf8");

const html = lire("index.html");
const OUVRE = '<script type="text/babel" data-presets="react">';
const debut = html.indexOf(OUVRE);
if (debut < 0 || html.indexOf(OUVRE, debut + 1) >= 0) throw new Error("Il faut exactement un bloc <script type=\"text/babel\">.");
const fin = html.indexOf("</script>", debut);
const source = html.slice(debut + OUVRE.length, fin);

const t0 = Date.now();
const { code } = Babel.transform(source, { presets: ["react"], sourceType: "script", filename: "app.jsx", compact: false, comments: false, retainLines: false });
new vm.Script(code, { filename: "app.js" }); // garde-fou : le résultat doit être du JavaScript valide

const versionMatch = html.match(/const VERSION = "v([\d.]+)";/);
const version = versionMatch ? versionMatch[1] : "?";

const LIGNE_BABEL = /\s*<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/babel-standalone\/[^"]+"><\/script>/;
if (!LIGNE_BABEL.test(html)) throw new Error("Balise du Babel en ligne introuvable dans index.html.");
const htmlDist = html.slice(0, debut).replace(LIGNE_BABEL, "") + '<script src="app.js" defer></script>' + html.slice(fin + "</script>".length);

let sw = lire("sw.js");
const LIGNE_SW = /\s*"https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/babel-standalone\/[^"]+",?/;
if (!LIGNE_SW.test(sw)) throw new Error("Babel introuvable dans la liste du service worker.");
sw = sw.replace(LIGNE_SW, "").replace('"./index.html",', '"./index.html",\n  "./app.js",');

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, "index.html"), htmlDist);
fs.writeFileSync(path.join(DIST, "app.js"), "// BioDex v" + version + " — précompilé depuis index.html (outils/precompiler.mjs). Ne pas éditer.\n" + code);
fs.writeFileSync(path.join(DIST, "sw.js"), sw);
for (const f of ["manifest.webmanifest", "icon-192.png", "icon-512.png", "emblem.png", "badge-96.png"]) fs.copyFileSync(path.join(RACINE, f), path.join(DIST, f));

const ko = (n) => Math.round(n / 1024) + " Ko";
console.log(`BioDex v${version} précompilé en ${Date.now() - t0} ms : index.html ${ko(Buffer.byteLength(htmlDist))}, app.js ${ko(Buffer.byteLength(code))}`);
