/** options.js : page de réglages de l'aide IA (clé, modèle, autorisations). */
"use strict";

const api = globalThis.browser ?? globalThis.chrome;
const ORIGINE = "https://openrouter.ai/*";
const MODELE_DEFAUT = "anthropic/claude-haiku-4.5";
const $ = (id) => document.getElementById(id);

function etat(texte, ok = true) {
  $("etat").textContent = texte;
  $("etat").style.color = ok ? "#1b6e2d" : "#b3261e";
}

async function charger() {
  const { reglage } = await api.storage.local.get("reglage");
  $("actif").checked = Boolean(reglage?.actif);
  $("cle").value = reglage?.cle ?? "";
  $("modele").value = reglage?.modele || MODELE_DEFAUT;
}

/** À appeler directement dans le gestionnaire de clic (geste utilisateur requis). */
function demanderPermissions() {
  const base = { origins: [ORIGINE] };
  try {
    return api.permissions.request({ ...base, data_collection: ["websiteContent"] });
  } catch {
    return api.permissions.request(base);
  }
}

$("enregistrer").addEventListener("click", async () => {
  const reglage = {
    actif: $("actif").checked,
    cle: $("cle").value.trim(),
    // On retire espaces et guillemets collés par erreur autour de l'identifiant.
    modele: $("modele").value.trim().replace(/^["'`]+|["'`]+$/g, "") || MODELE_DEFAUT
  };
  if (reglage.actif) {
    if (!reglage.cle) return etat("Entre ta clé API OpenRouter.", false);
    const accorde = await demanderPermissions();
    if (!accorde) return etat("Autorisation refusée : l'IA reste désactivée.", false);
  }
  await api.storage.local.set({ reglage });
  etat("Réglages enregistrés.");
});

$("tester").addEventListener("click", async () => {
  const bouton = $("tester");
  bouton.disabled = true;
  etat("Test en cours… (20 s au maximum)");
  try {
    // Filet de sécurité : si le background ne répond jamais, on ne reste pas bloqué.
    const rep = await Promise.race([
      api.runtime.sendMessage({ type: "askAI", test: true }),
      new Promise((_, rejet) => setTimeout(() => rejet(new Error("pas de réponse de l'extension après 30 s")), 30_000))
    ]);
    if (rep?.erreur) {
      const detail = rep.detail ? ` — ${rep.detail}` : "";
      const conseil = rep.erreur === "ia_desactivee" || rep.erreur === "permission" ? " Enregistre d'abord tes réglages." : "";
      etat(`Échec : ${rep.erreur}${detail}.${conseil}`, false);
    } else {
      etat("Connexion OK : OpenRouter a répondu.");
    }
  } catch (e) {
    etat(`Échec : ${e?.message ?? e}`, false);
  } finally {
    bouton.disabled = false;
  }
});

$("version").textContent = api.runtime.getManifest().version;
charger();
