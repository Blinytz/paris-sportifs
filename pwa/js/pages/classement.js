// Page classement d'un championnat (route #/classement/{league_id}).
// Données : table `standings` (classement officiel Highlightly). Si rien
// en base, lien de secours vers une recherche externe.

import { classementLigue, lireLigue } from '../api.js';
import {
  dateHeure, echapper, erreur, lienClassementExterne, nombre, squelettes, vide,
} from '../ui.js';

export async function pageClassement(conteneur, leagueId) {
  conteneur.innerHTML = squelettes(2);
  try {
    const [ligue, lignes] = await Promise.all([
      lireLigue(leagueId), classementLigue(leagueId),
    ]);
    if (!ligue) {
      conteneur.innerHTML = vide('🔍', 'Compétition introuvable');
      return;
    }
    if (!lignes.length) {
      conteneur.innerHTML = `
        <h1>${echapper(ligue.name)}</h1>
        ${vide('📊', 'Classement pas encore synchronisé',
          'Il arrive dès que la compétition a joué un match.')}
        <a class="carte centre lien-classement" href="${lienClassementExterne(ligue)}"
          target="_blank" rel="noopener">🔗 Voir le classement officiel</a>`;
      return;
    }

    const groupes = new Map();
    for (const l of lignes) {
      const cle = l.group_name || '';
      if (!groupes.has(cle)) groupes.set(cle, []);
      groupes.get(cle).push(l);
    }

    conteneur.innerHTML = `
      <h1>${echapper(ligue.name)}</h1>
      <p class="faible">Saison ${echapper(lignes[0].season)}
        · mis à jour le ${dateHeure(lignes[0].synced_at)}</p>
      ${[...groupes.entries()].map(([nom, liste]) => `
        ${nom ? `<h2>${echapper(nom)}</h2>` : ''}
        <div class="carte tableau-defilant">
          <table class="classement">
            <thead><tr>
              <th></th><th class="gauche">Équipe</th><th>Pts</th><th>J</th>
              <th>V</th><th>N</th><th>D</th><th>+</th><th>-</th><th>±</th>
            </tr></thead>
            <tbody>${liste.map(ligneTableau).join('')}</tbody>
          </table>
        </div>`).join('')}`;
  } catch (e) {
    conteneur.innerHTML = erreur(e);
  }
}

function ligneTableau(l) {
  const diff = (l.score_for ?? 0) - (l.score_against ?? 0);
  return `
    <tr>
      <td class="position">${echapper(l.position)}</td>
      <td class="gauche"><a href="#/equipe/${l.team_id}">${echapper(l.team?.name || '?')}</a></td>
      <td><strong>${nombre(l.points)}</strong></td>
      <td>${nombre(l.games_played)}</td>
      <td>${nombre(l.wins)}</td>
      <td>${nombre(l.draws)}</td>
      <td>${nombre(l.losses)}</td>
      <td>${nombre(l.score_for)}</td>
      <td>${nombre(l.score_against)}</td>
      <td>${diff > 0 ? '+' : ''}${nombre(diff)}</td>
    </tr>`;
}
