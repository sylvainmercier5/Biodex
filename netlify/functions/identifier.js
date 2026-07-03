// netlify/functions/identifier.js
// Fonction serverless BioDex : identification d'insecte + fiche naturaliste, via l'API Claude (Sonnet).
// La clé API vit UNIQUEMENT ici (variable d'environnement Netlify), jamais dans le navigateur.

const MODELE = "claude-sonnet-4-6";

exports.handler = async (event) => {
  const enTetes = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: enTetes, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: enTetes, body: JSON.stringify({ erreur: "Méthode non autorisée" }) };
  }

  const cle = process.env.ANTHROPIC_API_KEY;
  if (!cle) {
    return { statusCode: 500, headers: enTetes, body: JSON.stringify({ erreur: "Clé API non configurée sur le serveur." }) };
  }

  let corps;
  try { corps = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: enTetes, body: JSON.stringify({ erreur: "Requête illisible." }) }; }

  const mode = corps.mode || "identification";

  // Contexte fourni par l'observateur (aide l'identification)
  const ctx = [];
  if (corps.contexte) {
    const c = corps.contexte;
    if (c.biotope) ctx.push("Biotope observé : " + String(c.biotope).slice(0, 60));
    if (c.mois) ctx.push("Mois d'observation : " + String(c.mois).slice(0, 20));
    if (c.region) ctx.push("Région approximative : " + String(c.region).slice(0, 60));
    if (c.indice) ctx.push("Nom supposé par l'observateur : " + String(c.indice).slice(0, 120));
  }
  const blocCtx = ctx.length ? "\n\nContexte de terrain (à exploiter, sans le sur-interpréter) :\n- " + ctx.join("\n- ") : "";

  // ---- Construction du message selon le mode ----
  let messages, maxTokens, systeme;

  if (mode === "fiche") {
    // Génération d'une fiche naturaliste à partir d'un nom déjà identifié
    const nom = String(corps.nom || "").slice(0, 120);
    const nomSci = String(corps.nomSci || "").slice(0, 120);
    systeme =
      "Tu es un entomologiste francophone rigoureux. On te donne une espèce (ou un taxon) déjà identifiée. " +
      "Rédige une fiche naturaliste synthétique et fiable, en français. " +
      "IMPORTANT sur le statut de conservation : les listes rouges évoluent et tu ne peux pas les vérifier en temps réel. " +
      "N'affirme JAMAIS un statut avec certitude : donne une indication prudente et signale qu'elle doit être vérifiée. " +
      "Si tu n'es pas sûr d'un champ, mets une valeur honnête comme \"variable\", \"mal connu\" ou \"à vérifier\" plutôt que d'inventer. " +
      "Réponds UNIQUEMENT par un objet JSON valide, sans texte ni Markdown autour, de la forme exacte : " +
      '{"description":"2-3 phrases : allure générale, taille, traits distinctifs",' +
      '"alimentation":"régime de l\'adulte et de la larve si pertinent",' +
      '"periode":"période d\'apparition / mois de vol des adultes",' +
      '"habitat":"habitats et biotopes typiques",' +
      '"repartition":"répartition géographique générale (France/Europe si pertinent)",' +
      '"conservation":"statut indicatif et prudent, ex : \'apparemment commun, à vérifier\' ou \'espèce protégée en France, à confirmer\'",' +
      '"faits":"un ou deux faits marquants ou remarquables",' +
      '"fiabilite":"élevée|moyenne|faible — ta confiance globale dans cette fiche selon que le taxon est commun/bien connu ou non"}';
    messages = [{ role: "user", content: [{ type: "text", text: "Espèce à documenter : " + nom + (nomSci ? " (" + nomSci + ")" : "") + "." }] }];
    maxTokens = 900;
  } else {
    // Identification poussée à partir de la photo
    if (!corps.image || !corps.media_type) {
      return { statusCode: 400, headers: enTetes, body: JSON.stringify({ erreur: "Image manquante." }) };
    }
    systeme =
      "Tu es un entomologiste expert en identification visuelle. Analyse la photo avec méthode : " +
      "observe le nombre de pattes, la présence et le type d'ailes, les antennes, les pièces buccales, la forme du corps, " +
      "les proportions et la taille estimée, les couleurs et motifs. Déduis d'abord l'ordre, puis affine autant que l'image le permet. " +
      "Propose jusqu'à 3 hypothèses classées de la plus probable à la moins probable. " +
      "Ne force jamais une espèce précise si l'image ne le permet pas : reste au genre, à la famille ou à l'ordre selon ta certitude réelle. " +
      "Exploite le contexte de terrain s'il est fourni, mais l'image prime. " +
      "Réponds UNIQUEMENT par un objet JSON valide, sans texte ni Markdown autour, de la forme exacte : " +
      '{"nom":"nom vernaculaire français de l\'hypothèse principale",' +
      '"nomSci":"binôme ou taxon latin de l\'hypothèse principale",' +
      '"confiance":"élevée|moyenne|faible",' +
      '"niveau":"espèce|genre|famille|ordre",' +
      '"note":"justification courte : critères visuels décisifs, ou pourquoi l\'ID reste incertaine",' +
      '"alternatives":[{"nom":"","nomSci":"","pourquoi":"ce qui distinguerait cette hypothèse"}]}. ' +
      "Le tableau alternatives contient 0 à 2 hypothèses secondaires (vide si tu es très sûr).";
    messages = [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: corps.media_type, data: corps.image } },
        { type: "text", text: "Identifie cet arthropode." + blocCtx },
      ],
    }];
    maxTokens = 700;
  }

  try {
    const reponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": cle, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODELE, max_tokens: maxTokens, system: systeme, messages }),
    });

    if (!reponse.ok) {
      const txt = await reponse.text();
      return { statusCode: 502, headers: enTetes, body: JSON.stringify({ erreur: "L'API a renvoyé une erreur.", detail: txt.slice(0, 300) }) };
    }

    const data = await reponse.json();
    const texte = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();

    let resultat = null;
    try {
      const propre = texte.replace(/```json/gi, "").replace(/```/g, "").trim();
      resultat = JSON.parse(propre);
    } catch {
      resultat = mode === "fiche"
        ? { description: texte.slice(0, 500), fiabilite: "faible" }
        : { nom: "", nomSci: "", confiance: "faible", niveau: "", note: texte.slice(0, 300), alternatives: [] };
    }

    return { statusCode: 200, headers: enTetes, body: JSON.stringify({ ok: true, mode, resultat }) };
  } catch (e) {
    return { statusCode: 500, headers: enTetes, body: JSON.stringify({ erreur: "Impossible de contacter le service.", detail: String(e).slice(0, 200) }) };
  }
};
