// Saisie de pronostic partagée par la page Paris et la page Match.
//
// Deux notions distinctes (comme sur MPP) :
//   - ENREGISTRER : dès que les deux cases sont remplies, le pronostic
//     est sauvegardé en brouillon. Modifiable de partout, tant que le
//     match n'a pas commencé.
//   - VALIDER : au coup d'envoi, le serveur transforme le brouillon en
//     pari ferme et débite la mise (fonction validate_due_drafts).
//
// Confort de frappe : au football un score tient sur un chiffre dans la
// quasi-totalité des cas, le curseur saute donc à la seconde case après
// un chiffre (deux au rugby). Revenir sur une case déjà remplie permet
// d'y saisir un second chiffre.

import { enregistrerBrouillon, supprimerBrouillon } from './api.js';
import { echapper, toast } from './ui.js';

const DELAI_ENREGISTREMENT = 700;

export function chiffresAttendus(sport) {
  return sport === 'rugby' ? 2 : 1;
}

// Deux cases de score, pré-remplies par le brouillon éventuel
export function casesScore(match, brouillon, { taille = '' } = {}) {
  const val = (v) => (v === undefined || v === null ? '' : v);
  return `
    <div class="cases-score" data-match="${match.id}"
         data-sport="${echapper(match.league?.sport || 'football')}">
      <input class="case-score ${taille}" data-camp="home" type="number"
             min="0" max="199" inputmode="numeric"
             value="${val(brouillon?.predicted_home)}"
             aria-label="Score ${echapper(match.home?.name)}">
      <span class="deux-points">:</span>
      <input class="case-score ${taille}" data-camp="away" type="number"
             min="0" max="199" inputmode="numeric"
             value="${val(brouillon?.predicted_away)}"
             aria-label="Score ${echapper(match.away?.name)}">
    </div>`;
}

/**
 * Rend les cases fonctionnelles.
 * @param {Element} racine élément contenant .cases-score
 * @param {object} options
 *   - mise : montant à enregistrer avec le brouillon
 *   - surEtat(texte, classe) : retour visuel (facultatif)
 *   - surChangement(home, away) : appelé après enregistrement (facultatif)
 */
export function brancherCases(racine, { mise, surEtat, surChangement } = {}) {
  const bloc = racine.querySelector('.cases-score');
  if (!bloc || !bloc.dataset.match) return;
  const champs = [...bloc.querySelectorAll('.case-score')];
  if (champs.length !== 2) return;

  const attendus = chiffresAttendus(bloc.dataset.sport);
  const dire = (texte, classe = 'faible') => {
    if (surEtat) surEtat(texte, classe);
  };
  let minuteur = null;

  const lire = () => champs.map((c) => c.value.trim());

  const enregistrer = async () => {
    clearTimeout(minuteur);
    const [h, a] = lire();
    try {
      if (h === '' && a === '') {
        await supprimerBrouillon(bloc.dataset.match);
        dire('Pronostic effacé');
      } else if (h === '' || a === '') {
        dire('Complète les deux cases');
        return;
      } else {
        await enregistrerBrouillon(bloc.dataset.match, Number(h), Number(a), mise);
        dire('Enregistré ✓', 'ok');
        if (surChangement) surChangement(Number(h), Number(a));
      }
    } catch (e) {
      dire(`Non enregistré : ${e.message}`, 'erreur');
      toast(e.message, 'echec');
    }
  };

  champs.forEach((champ, index) => {
    champ.addEventListener('focus', () => {
      champ.select();          // une nouvelle frappe remplace la valeur
      delete champ.dataset.saute;  // le saut ne se fait qu'une fois par visite
    });

    champ.addEventListener('input', () => {
      champ.classList.toggle('rempli', champ.value.trim() !== '');
      // Saut automatique vers la case suivante quand le nombre de
      // chiffres habituel est atteint (1 au foot, 2 au rugby)
      if (index === 0 && !champ.dataset.saute
          && champ.value.trim().length >= attendus) {
        champ.dataset.saute = '1';
        champs[1].focus();
      }
      const [h, a] = lire();
      if (h !== '' && a !== '') dire('Enregistrement…');
      clearTimeout(minuteur);
      minuteur = setTimeout(enregistrer, DELAI_ENREGISTREMENT);
    });

    champ.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') { evt.preventDefault(); champ.blur(); enregistrer(); }
      // Retour arrière sur une case vide : revenir à la précédente
      if (evt.key === 'Backspace' && champ.value === '' && index === 1) {
        champs[0].focus();
      }
    });

    champ.addEventListener('blur', () => {
      const [h, a] = lire();
      if (h !== '' && a !== '') { clearTimeout(minuteur); enregistrer(); }
    });
  });
}
