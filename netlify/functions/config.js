// netlify/functions/config.js
// Fournit à l'appli la configuration publique Supabase (URL + clé publishable),
// lue depuis les variables d'environnement Netlify. Évite d'avoir à coller la clé dans le code.
// NB : la clé publishable Supabase est publique par nature (destinée au navigateur).

exports.handler = async () => {
  const enTetes = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=300", // cache 5 min côté client/CDN
  };
  return {
    statusCode: 200,
    headers: enTetes,
    body: JSON.stringify({
      supabaseUrl: process.env.SUPABASE_URL || "",
      supabaseKey: process.env.SUPABASE_KEY || "",
    }),
  };
};
