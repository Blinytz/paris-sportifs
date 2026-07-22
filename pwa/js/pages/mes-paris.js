// Mes paris : bandeau « à récolter » en haut (avec Tout récolter), puis
// les paris en cours, puis l'historique déjà encaissé.
// Rien ne rejoint le portefeuille sans une action ici (ou sur la page
// d'un match) : c'est la collecte manuelle.

import { collecter, mesParis } from '../api.js';
import {
  blason, dateHeure, echapper, eclats, envoyerPieces, erreur, gainPari,
  libelleBonus, squelettes, toast, vide,
} from '../ui.js';

const LIBELLES = {
  pending: 'en cours', won: 'gagné', lost: 'perdu', void: 'remboursé',
};

export async function pageMesParis(conteneur) {
  conteneur.innerHTML = squelettes(4);
  try {
    const paris = await mesParis();
    rendre(conteneur, paris);
  } catch (e) {
    conteneur.innerHTML = erreur(e);
  }
}

function montantACollecter(p) {
  return p.status === 'won' ? gainPari(p) : Number(p.stake_eclats);
}

// Plus le gain est gros, plus il y a de pièces (dans des bornes lisibles)
function nbPieces(montant) {
  return Math.max(4, Math.min(12, Math.round(montant / 90) + 4));
}

function rendre(conteneur, paris) {
  const aCollecter = paris.filter(
    (p) => !p.collected_at && (p.status === 'won' || p.status === 'void'));
  const enCours = paris.filter((p) => p.status === 'pending');
  const historique = paris.filter(
    (p) => p.status === 'lost' || p.collected_at);

  if (!paris.length) {
    conteneur.innerHTML = `<h1>Mes paris</h1>${vide('🎟️', 'Aucun pari pour le moment',
      'Saisis un score depuis l\'onglet Paris pour te lancer.')}`;
    return;
  }

  const total = aCollecter.reduce((s, p) => s + montantACollecter(p), 0);
  conteneur.innerHTML = `
    <h1>Mes paris</h1>
    ${aCollecter.length ? `
      <div class="bandeau-collecte" id="bandeau-collecte">
        <div class="details">
          <div class="montant">${eclats(total)} ✦</div>
          <div class="sous">${aCollecter.length} pari${aCollecter.length > 1 ? 's' : ''}
            à récolter</div>
        </div>
        <button class="btn-or" id="tout-collecter">Tout récolter</button>
      </div>
      ${aCollecter.map((p) => cartePari(p, true)).join('')}` : ''}

    ${enCours.length ? `<h2>En cours (${enCours.length})</h2>
      ${enCours.map((p) => cartePari(p)).join('')}` : ''}

    ${historique.length ? `<h2>Historique</h2>
      ${historique.slice(0, 40).map((p) => cartePari(p)).join('')}` : ''}`;

  brancherCollecte(conteneur, aCollecter);
}

function cartePari(p, recoltable = false) {
  const m = p.match;
  const termine = m?.status === 'finished';
  const montant = montantACollecter(p);
  return `
    <div class="carte" data-pari="${p.id}">
      <div class="match-entete">
        <a class="competition" href="#/match/${p.match_id}">
          ${m?.league?.sport === 'rugby' ? '🏉' : '⚽'} ${echapper(m?.league?.name || '')}
        </a>
        <span>${dateHeure(m?.kickoff_at)}</span>
      </div>
      <div class="match-corps">
        <a class="equipe" href="#/equipe/${m?.home_team_id}">
          ${blason(m?.home)}<span class="nom">${echapper(m?.home?.name)}</span>
        </a>
        <div class="bloc-score">
          <div class="cases-score">
            <div class="score-fige">${termine ? m.score_home : '?'}</div>
            <span class="deux-points">:</span>
            <div class="score-fige">${termine ? m.score_away : '?'}</div>
          </div>
          <div class="faible">pronostic ${p.predicted_home} - ${p.predicted_away}</div>
        </div>
        <a class="equipe" href="#/equipe/${m?.away_team_id}">
          ${blason(m?.away)}<span class="nom">${echapper(m?.away?.name)}</span>
        </a>
      </div>
      <div class="match-pied">
        <div>
          <div class="libelle">${eclats(p.stake_eclats)} ✦ à ${echapper(Number(p.odds_at_bet).toFixed(2))}
            · ${LIBELLES[p.status] || echapper(p.status)}</div>
          <div class="valeur">
            ${p.status === 'won'
              ? `+${eclats(gainPari(p))} ✦ <span class="faible">${echapper(libelleBonus(p, m?.score_home, m?.score_away))}</span>`
              : p.status === 'lost' ? `<span class="erreur">−${eclats(p.stake_eclats)} ✦</span>`
              : p.status === 'void' ? `${eclats(p.stake_eclats)} ✦ rendus`
              : `gain possible ${eclats(p.potential_payout)} ✦`}
          </div>
        </div>
        ${recoltable
          ? `<button class="btn-or bouton-recolter" data-pari="${p.id}"
               data-montant="${montant}">Récolter</button>`
          : ''}
      </div>
    </div>`;
}

function brancherCollecte(conteneur, aCollecter) {
  const rafraichir = async () => {
    try {
      rendre(conteneur, await mesParis());
    } catch (e) {
      conteneur.innerHTML = erreur(e);
    }
  };

  // Récolte unitaire
  conteneur.querySelectorAll('.bouton-recolter').forEach((bouton) => {
    bouton.addEventListener('click', async () => {
      const carte = bouton.closest('.carte');
      bouton.disabled = true;
      bouton.textContent = '…';
      try {
        await collecter([bouton.dataset.pari]);
        envoyerPieces(carte, nbPieces(Number(bouton.dataset.montant)));
        carte.classList.add('collectee');
        window.dispatchEvent(new Event('eclats-collectes'));
        setTimeout(rafraichir, 900);
      } catch (e) {
        bouton.disabled = false;
        bouton.textContent = 'Récolter';
        toast(e.message, 'echec');
      }
    });
  });

  // Tout récolter : les cartes partent en cascade
  const tout = conteneur.querySelector('#tout-collecter');
  if (!tout) return;
  tout.addEventListener('click', async () => {
    tout.disabled = true;
    tout.textContent = 'Récolte…';
    const bandeau = conteneur.querySelector('#bandeau-collecte');
    try {
      const total = await collecter(null);
      // Cascade : une volée de pièces par carte, décalée dans le temps
      const cartes = aCollecter.map(
        (p) => conteneur.querySelector(`.carte[data-pari="${p.id}"]`));
      cartes.forEach((carte, i) => {
        if (!carte) return;
        setTimeout(() => {
          envoyerPieces(carte, 4);
          carte.classList.add('collectee');
        }, i * 90);
      });
      // Un seul événement : le compteur ne roule qu'une fois, vers le total
      window.dispatchEvent(new Event('eclats-collectes'));
      toast(`+${eclats(total)} ✦ récoltés`, 'succes');
      if (bandeau) bandeau.classList.add('collectee');
      setTimeout(rafraichir, 1100 + cartes.length * 90);
    } catch (e) {
      tout.disabled = false;
      tout.textContent = 'Tout récolter';
      toast(e.message, 'echec');
    }
  });
}
