// Page classement d'un championnat — route #/classement/{league_id}.
// Données : table `standings` (classement officiel Highlightly, rafraîchi
// en rotation par le sync). Si rien en base, lien de secours externe.

import { classementLigue, lireLigue } from '../api.js';
import {
  chargement, dateHeure, echapper, erreur, lienClassementExterne, nombre,
} from '../ui.js';

export async function pageClassement(conteneur, leagueId) {
  conteneur.innerHTML = chargement();
  try {
    const [ligue, lignes] = await Promise.all([
      lireLigue(leagueId), classementLigue(leagueId),
    ]);
    if (!ligue) {
      conteneur.innerHTML = '<p class="erreur">Compétition introuvable.</p>';
      return;
    }
    if (!lignes.length) {
      conteneur.innerHTML = `
        <h1>Classement — ${echapper(ligue.name)}</h1>
        <p class="muet">Classement pas encore synchronisé pour cette
          compétition (il arrive au fil des runs quotidiens, en rotation).</p>
        <p><a class="carte" href="${lienClassementExterne(ligue)}" target="_blank"
          rel="noopener">🔗 Voir le classement officiel (recherche externe)</a></p>`;
      return;
    }

    // Groupes éventuels (poules) — null = poule unique
    const groupes = new Map();
    for (const l of lignes) {
      const cle = l.group_name || '';
      if (!groupes.has(cle)) groupes.set(cle, []);
      groupes.get(cle).push(l);
    }

    conteneur.innerHTML = `
      <h1>Classement — ${echapper(ligue.name)}</h1>
      <p class="muet">Saison ${echapper(lignes[0].season)} · mis à jour le
        ${dateHeure(lignes[0].synced_at)}</p>
      ${[...groupes.entries()].map(([nom, liste]) => `
        ${nom ? `<h2>${echapper(nom)}</h2>` : ''}
        <div class="carte tableau-defilant">
          <table class="classement">
            <thead><tr>
              <th></th><th class="gauche">Équipe</th><th>Pts</th><th>J</th>
              <th>V</th><th>N</th><th>D</th><th>+</th><th>−</th><th>±</th>
            </tr></thead>
            <tbody>
              ${liste.map(ligneTableau).join('')}
            </tbody>
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
      <td class="gras">${nombre(l.points)}</td>
      <td>${nombre(l.games_played)}</td>
      <td>${nombre(l.wins)}</td>
      <td>${nombre(l.draws)}</td>
      <td>${nombre(l.losses)}</td>
      <td>${nombre(l.score_for)}</td>
      <td>${nombre(l.score_against)}</td>
      <td>${diff > 0 ? '+' : ''}${nombre(diff)}</td>
    </tr>`;
}
