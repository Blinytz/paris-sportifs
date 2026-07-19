// Accueil : calendrier des matchs à venir, filtrable par sport et
// compétition, avec les dernières cotes générées.

import { dernieresCotes, listeLigues, prochainsMatchs } from '../api.js';
import { chargement, echapper, erreur, jour, nombre } from '../ui.js';

const filtres = { sport: '', leagueId: '' };
let liguesCache = null;

export async function pageAccueil(conteneur) {
  conteneur.innerHTML = chargement();
  try {
    liguesCache = liguesCache || await listeLigues();
    await rendre(conteneur);
  } catch (e) {
    conteneur.innerHTML = erreur(e);
  }
}

async function rendre(conteneur) {
  const matchs = await prochainsMatchs(filtres.leagueId
    ? { leagueId: filtres.leagueId }
    : { sport: filtres.sport || undefined });
  const cotes = await dernieresCotes(matchs.map((m) => m.id));

  const liguesVisibles = liguesCache.filter(
    (l) => !filtres.sport || l.sport === filtres.sport);
  const optionsLigues = liguesVisibles.map((l) =>
    `<option value="${l.id}" ${l.id === filtres.leagueId ? 'selected' : ''}>
      ${echapper(l.name)}${l.country && l.country !== 'World' ? ` (${echapper(l.country)})` : ''}
    </option>`).join('');

  // Regroupement par jour
  const parJour = new Map();
  for (const m of matchs) {
    const cle = jour(m.kickoff_at);
    if (!parJour.has(cle)) parJour.set(cle, []);
    parJour.get(cle).push(m);
  }

  conteneur.innerHTML = `
    <div class="filtres">
      <select id="filtre-sport">
        <option value="">Tous les sports</option>
        <option value="football" ${filtres.sport === 'football' ? 'selected' : ''}>Football</option>
        <option value="rugby" ${filtres.sport === 'rugby' ? 'selected' : ''}>Rugby</option>
      </select>
      <select id="filtre-ligue">
        <option value="">Toutes les compétitions</option>
        ${optionsLigues}
      </select>
    </div>
    ${matchs.length === 0 ? '<p class="muet">Aucun match à venir dans la fenêtre synchronisée.</p>' : ''}
    ${[...parJour.entries()].map(([libelle, liste]) => `
      <h2 class="jour">${echapper(libelle)}</h2>
      ${liste.map((m) => carteMatch(m, cotes.get(m.id))).join('')}
    `).join('')}`;

  conteneur.querySelector('#filtre-sport').addEventListener('change', (evt) => {
    filtres.sport = evt.target.value;
    filtres.leagueId = '';
    rendre(conteneur);
  });
  conteneur.querySelector('#filtre-ligue').addEventListener('change', (evt) => {
    filtres.leagueId = evt.target.value;
    rendre(conteneur);
  });
}

function carteMatch(m, cote) {
  const heure = new Date(m.kickoff_at).toLocaleTimeString('fr-FR',
    { hour: '2-digit', minute: '2-digit' });
  return `
    <a class="carte carte-match" href="#/match/${m.id}">
      <div class="carte-match-entete">
        <span class="muet">${echapper(m.league?.name || '')} · ${heure}</span>
        <span class="pastille">${m.league?.sport === 'rugby' ? '🏉' : '⚽'}</span>
      </div>
      <div class="carte-match-equipes">
        <span>${echapper(m.home?.name)}</span>
        <span class="muet">vs</span>
        <span>${echapper(m.away?.name)}</span>
      </div>
      ${cote ? `
      <div class="carte-match-cotes">
        <span>1 · ${nombre(cote.home_odds, 2)}</span>
        ${cote.draw_odds ? `<span>N · ${nombre(cote.draw_odds, 2)}</span>` : ''}
        <span>2 · ${nombre(cote.away_odds, 2)}</span>
      </div>` : '<div class="muet">Cotes pas encore générées</div>'}
    </a>`;
}
