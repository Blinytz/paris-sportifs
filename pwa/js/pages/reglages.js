// Page réglages (section 7.4) : un champ par paramètre de model_settings,
// valeur actuelle éditable + valeur par défaut + texte explicatif fixe
// (repris tel quel de la spec), bouton de réinitialisation.
// Un changement s'applique automatiquement au prochain run des scripts
// (règle 10 : rien n'est en dur côté serveur).

import { lireReglages, sauverReglages } from '../api.js';
import { echapper, erreur, nombre, squelettes, toast } from '../ui.js';

const AIDE_K = "Contrôle à quel point un seul résultat fait bouger le rating d'une équipe. Faible (10-16) : ratings très stables, réagit peu aux surprises. Standard (24-32) : équilibre courant. Élevé (40-60) : très réactif, un seul résultat surprenant fait fortement bouger le rating, utile en début d'usage, mais risque de surréagir à un accident isolé.";
const AIDE_TERRAIN = "Bonus fictif donné à l'équipe qui reçoit avant de calculer le favori. 0 : aucun avantage pris en compte. Faible (20-40) : léger avantage. Standard (65 foot / 50 rugby) : reflète la moyenne observée. Élevé (90-120+) : favorise fortement le domicile, au risque de sous-estimer les bonnes équipes à l'extérieur.";
const AIDE_MARGE = "Réduit légèrement chaque cote par rapport à la probabilité pure calculée. 1.00 : aucune marge, système parfaitement équilibré sur le long terme. 1.05 (défaut) : léger avantage maison. 1.10-1.15 : marge plus agressive, cotes moins généreuses. Une valeur sous 1.00 avantage volontairement les paris.";
const AIDE_BORNES = "Empêchent les cotes extrêmes. Baisser le minimum autorise des cotes quasi nulles sur un favori écrasant. Monter le maximum autorise des cotes très élevées sur un outsider extrême, plus excitant en cas d'exploit, utile aussi en tout début quand les ratings sont encore mal calibrés.";
const AIDE_NUL = "Contrôle l'estimation du nul en foot selon l'écart de niveau entre les équipes. Base plus haute : le nul est jugé plus probable dans l'absolu. Diviseur plus petit : la probabilité de nul chute plus vite dès qu'un écart de niveau apparaît. Diviseur plus grand : le nul reste probable même avec un écart important.";
const AIDE_NUL_RUGBY = "Le nul est pariable au rugby aussi, mais il est rare : ces bornes maintiennent sa probabilité basse, donc sa cote haute (plafonnée par la cote maximale). Monter la base rend le nul rugby moins rémunérateur ; la baisser le rend quasi injouable.";
const AIDE_BONUS = "Multiplicateurs du pari sur score. Bonne issue seule : gain = mise × cote. Bon écart signé en plus (ex. 1-0 pronostiqué, 2-1 réel) : gain × bonus écart. Score exact : gain × bonus score exact. Un pronostic de nul gagnant a d'office le bon écart (0) : il utilise le bonus écart nul, réduit exprès pour ne pas rendre le pari nul systématiquement trop rentable.";
const AIDE_MISE = "Montant misé automatiquement depuis l'accueil dès que les deux cases de score sont remplies. Pour miser un autre montant sur un match précis, ouvrir sa page et utiliser le formulaire détaillé.";
const AIDE_BONUS_RUGBY = "Au rugby les scores sont élevés : trouver le score exact est quasi impossible, d'où un bonus très fort (×10 par défaut). Le « bon écart » s'y juge par tranche de points : 0-7, 8-14, 15-21, 22-28, 29-40, plus de 40. Pronostiquer un écart dans la bonne tranche suffit pour décrocher le bonus.";
const AIDE_FORME ="Nombre de matchs pris en compte pour calculer \"la forme actuelle\" d'une équipe. Petite fenêtre (3) : très réactive mais bruitée. Grande fenêtre (10) : tendance lissée mais plus lente à refléter un vrai changement.";

// Valeurs par défaut de la section 6 de la spec (bouton réinitialiser)
export const CHAMPS = [
  { cle: 'elo_k_factor', libelle: 'K-factor (réactivité du Elo)', defaut: 32, pas: 1, aide: AIDE_K },
  { cle: 'home_advantage_football', libelle: 'Avantage terrain foot', defaut: 65, pas: 5, aide: AIDE_TERRAIN },
  { cle: 'home_advantage_rugby', libelle: 'Avantage terrain rugby', defaut: 50, pas: 5, aide: AIDE_TERRAIN },
  { cle: 'margin_factor', libelle: 'Marge maison', defaut: 1.05, pas: 0.01, aide: AIDE_MARGE },
  { cle: 'odds_min', libelle: 'Cote minimale', defaut: 1.05, pas: 0.01, aide: AIDE_BORNES },
  { cle: 'odds_max', libelle: 'Cote maximale', defaut: 15.00, pas: 0.5, aide: AIDE_BORNES },
  { cle: 'draw_base_prob', libelle: 'Probabilité de nul (base)', defaut: 0.28, pas: 0.01, aide: AIDE_NUL },
  { cle: 'draw_min_prob', libelle: 'Probabilité de nul (plancher)', defaut: 0.15, pas: 0.01, aide: AIDE_NUL },
  { cle: 'draw_max_prob', libelle: 'Probabilité de nul (plafond)', defaut: 0.30, pas: 0.01, aide: AIDE_NUL },
  { cle: 'draw_gap_divisor', libelle: "Probabilité de nul (diviseur d'écart)", defaut: 4000, pas: 100, aide: AIDE_NUL },
  { cle: 'draw_base_prob_rugby', libelle: 'Nul rugby (base)', defaut: 0.04, pas: 0.01, aide: AIDE_NUL_RUGBY },
  { cle: 'draw_min_prob_rugby', libelle: 'Nul rugby (plancher)', defaut: 0.02, pas: 0.01, aide: AIDE_NUL_RUGBY },
  { cle: 'draw_max_prob_rugby', libelle: 'Nul rugby (plafond)', defaut: 0.05, pas: 0.01, aide: AIDE_NUL_RUGBY },
  { cle: 'bonus_ecart', libelle: 'Bonus bon écart', defaut: 1.5, pas: 0.1, aide: AIDE_BONUS },
  { cle: 'bonus_ecart_nul', libelle: 'Bonus bon écart (pronostic nul)', defaut: 1.25, pas: 0.05, aide: AIDE_BONUS },
  { cle: 'bonus_score_exact', libelle: 'Bonus score exact', defaut: 2.0, pas: 0.1, aide: AIDE_BONUS },
  { cle: 'bonus_ecart_rugby', libelle: 'Bonus tranche d\'écart (rugby)', defaut: 1.5, pas: 0.1, aide: AIDE_BONUS_RUGBY },
  { cle: 'bonus_score_exact_rugby', libelle: 'Bonus score exact (rugby)', defaut: 10, pas: 0.5, aide: AIDE_BONUS_RUGBY },
  { cle: 'form_window_size', libelle: 'Fenêtre de forme récente', defaut: 5, pas: 1, aide: AIDE_FORME },
  { cle: 'default_stake', libelle: 'Mise des paris rapides', defaut: 100, pas: 10, aide: AIDE_MISE },
];

export async function pageReglages(conteneur) {
  conteneur.innerHTML = squelettes(3);
  try {
    const valeurs = await lireReglages();
    if (!valeurs) {
      conteneur.innerHTML = '<p class="erreur">model_settings introuvable : exécuter sql/schema.sql.</p>';
      return;
    }
    conteneur.innerHTML = `
      <h1>Réglages</h1>
      <p class="faible">Appliqués automatiquement à la prochaine
        synchronisation, sans redéploiement.</p>
      <form id="formulaire-reglages">
        ${CHAMPS.map((c) => champ(c, valeurs[c.cle])).join('')}
        <div class="rangee-boutons">
          <button type="submit" class="btn-or">Enregistrer</button>
          <button type="button" id="bouton-defauts" class="btn-fantome">
            Valeurs par défaut</button>
        </div>
        <p id="retour-reglages" class="faible"></p>
      </form>`;
    brancher(conteneur);
  } catch (e) {
    conteneur.innerHTML = erreur(e);
  }
}

function champ(c, valeurActuelle) {
  return `
    <div class="carte champ-reglage">
      <label for="champ-${c.cle}"><strong>${echapper(c.libelle)}</strong></label>
      <div class="rangee-mise">
        <input type="number" id="champ-${c.cle}" name="${c.cle}" step="${c.pas}"
               value="${echapper(valeurActuelle)}" required>
        <span class="defaut">défaut : ${nombre(c.defaut, String(c.pas).includes('.') ? 2 : 0)}</span>
      </div>
      <p class="aide">${echapper(c.aide)}</p>
    </div>`;
}

function brancher(conteneur) {
  const formulaire = conteneur.querySelector('#formulaire-reglages');
  const retour = conteneur.querySelector('#retour-reglages');

  formulaire.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    const donnees = new FormData(formulaire);
    const valeurs = {};
    for (const c of CHAMPS) valeurs[c.cle] = Number(donnees.get(c.cle));
    retour.textContent = 'Enregistrement…';
    try {
      await sauverReglages(valeurs);
      retour.textContent = 'Réglages enregistrés ✓';
      toast('Réglages enregistrés', 'succes');
    } catch (e) {
      retour.textContent = `Échec : ${e.message}`;
      toast(e.message, 'echec');
    }
  });

  conteneur.querySelector('#bouton-defauts').addEventListener('click', () => {
    for (const c of CHAMPS) {
      formulaire.elements[c.cle].value = c.defaut;
    }
    retour.textContent = 'Valeurs par défaut restaurées : cliquer Enregistrer pour valider.';
  });
}
