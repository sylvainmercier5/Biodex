// netlify/functions/identifier.js
// Fonction serverless : identifie un insecte à partir d'une photo, via l'API Claude.
// La clé API vit UNIQUEMENT ici (variable d'environnement Netlify), jamais dans le navigateur.

exports.handler = async (event) => {
  const enTetes = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  // Pré-vol CORS
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: enTetes, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: enTetes, body: JSON.stringify({ erreur: "Méthode non autorisée" }) };
  }

  const cle = process.env.ANTHROPIC_API_KEY;
  if (!cle) {
    return { statusCode: 500, headers: enTetes, body: JSON.stringify({ erreur: "Clé API non configurée sur le serveur." }) };
  }

  let corps;
  try {
    corps = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: enTetes, body: JSON.stringify({ erreur: "Requête illisible." }) };
  }

  const { image, media_type, indice } = corps;
  if (!image || !media_type) {
    return { statusCode: 400, headers: enTetes, body: JSON.stringify({ erreur: "Image manquante." }) };
  }

  const consigne =
    "Tu es un entomologiste. Identifie l'insecte (ou l'arthropode) sur la photo. " +
    "Réponds UNIQUEMENT par un objet JSON valide, sans texte autour, sans balises Markdown, de la forme : " +
    '{"nom":"nom vernaculaire français","nomSci":"binôme latin","confiance":"élevée|moyenne|faible","niveau":"espèce|genre|famille|ordre","note":"une courte phrase (habitat, trait distinctif, ou pourquoi l\'ID est incertaine)"}. ' +
    "Si la photo ne montre aucun arthropode identifiable, renvoie confiance \"faible\" et explique-le dans note. " +
    "Ne te force jamais à donner une espèce précise si l'image ne le permet pas : reste au genre, à la famille ou à l'ordre selon ce dont tu es sûr." +
    (indice ? " Indice fourni par l'observateur : " + String(indice).slice(0, 200) : "");

  try {
    const reponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cle,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type, data: image } },
              { type: "text", text: consigne },
            ],
          },
        ],
      }),
    });

    if (!reponse.ok) {
      const txt = await reponse.text();
      return {
        statusCode: 502,
        headers: enTetes,
        body: JSON.stringify({ erreur: "L'API d'identification a renvoyé une erreur.", detail: txt.slice(0, 300) }),
      };
    }

    const data = await reponse.json();
    const texte = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    // On tente de parser le JSON renvoyé par le modèle
    let resultat = null;
    try {
      const propre = texte.replace(/```json/gi, "").replace(/```/g, "").trim();
      resultat = JSON.parse(propre);
    } catch {
      // Repli : on renvoie le texte brut si le modèle n'a pas respecté le format
      resultat = { nom: "", nomSci: "", confiance: "faible", niveau: "", note: texte.slice(0, 300) };
    }

    return { statusCode: 200, headers: enTetes, body: JSON.stringify({ ok: true, resultat }) };
  } catch (e) {
    return {
      statusCode: 500,
      headers: enTetes,
      body: JSON.stringify({ erreur: "Impossible de contacter le service d'identification.", detail: String(e).slice(0, 200) }),
    };
  }
};
