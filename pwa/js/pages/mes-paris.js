// Historique des paris de l'utilisateur (pending / won / lost / void).

import { mesParis } from '../api.js';
import { chargement, dateHeure, echapper, erreur, nombre } from '../ui.js';

const LIBELLES = {
  pending: 'En cours', won: 'Gagné', lost: 'Perdu', void: 'Remboursé',
};
const SELECTIONS = { home: '1 (domicile)', draw: 'Nul', away: '2 (extérieur)' };

export async function pageMesParis(conteneur) {
  conteneur.innerHTML = chargement();
  try {
    const paris = await mesParis();
    if (!paris.length) {
      conteneur.innerHTML = '<h1>Mes paris</h1><p class="muet">Aucun pari placé pour le moment.</p>';
      return;
    }
    const mises = paris.reduce((s, p) => s + Number(p.stake_eclats), 0);
    const gains = paris.filter((p) => p.status === 'won')
      .reduce((s, p) => s + Number(p.potential_payout), 0);
    const rembourses = paris.filter((p) => p.status === 'void')
      .reduce((s, p) => s + Number(p.stake_eclats), 0);
    conteneur.innerHTML = `
      <h1>Mes paris</h1>
      <p class="muet">${paris.length} paris · ${nombre(mises)} ✦ misés ·
        ${nombre(gains)} ✦ gagnés · ${nombre(rembourses)} ✦ remboursés</p>
      ${paris.map(cartePari).join('')}`;
  } catch (e) {
    conteneur.innerHTML = erreur(e);
  }
}

function cartePari(p) {
  const m = p.match;
  return `
    <a class="carte carte-pari statut-${p.status}" href="#/match/${p.match_id}">
      <div class="carte-match-entete">
        <span class="muet">${echapper(m?.league?.name || '')} · ${dateHeure(m?.kickoff_at)}</span>
        <span class="pastille pastille-${p.status}">${LIBELLES[p.status] || echapper(p.status)}</span>
      </div>
      <div class="carte-match-equipes">
        <span>${echapper(m?.home?.name)}</span>
        <span class="muet">${m?.status === 'finished'
          ? `${m.score_home} – ${m.score_away}` : 'vs'}</span>
        <span>${echapper(m?.away?.name)}</span>
      </div>
      <div class="carte-pari-detail">
        ${echapper(SELECTIONS[p.selection] || p.selection)} ·
        mise ${nombre(p.stake_eclats)} ✦ · cote ${nombre(p.odds_at_bet, 2)} ·
        gain potentiel ${nombre(p.potential_payout, 2)} ✦
      </div>
    </a>`;
}
