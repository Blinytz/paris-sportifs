// Page équipe : en-tête (blason, Elo, position), vue d'ensemble,
// cartes dépliables par compétition, derniers et prochains matchs.

import {
  lireEquipe, lireReglages, matchsEquipe, positionsEquipe, statsGlobales,
  statsParCompetition,
} from '../api.js';
import {
  badgesForme, blason, dateHeure, echapper, erreur, formeDepuisMatchs,
  lienClassementExterne, nombre, ordinal, squelettes, vide,
} from '../ui.js';

export async function pageEquipe(conteneur, teamId) {
  conteneur.innerHTML = squelettes(3);
  try {
    const [equipe, globales, parCompetition, reglages, derniers, prochains,
           positions] = await Promise.all([
      lireEquipe(teamId),
      statsGlobales(teamId),
      statsParCompetition(teamId),
      lireReglages(),
      matchsEquipe(teamId, { statut: 'finished', limite: 12 }),
      matchsEquipe(teamId, { statut: 'scheduled', limite: 8 }),
      positionsEquipe(teamId),
    ]);
    if (!equipe) {
      conteneur.innerHTML = vide('🔍', 'Équipe introuvable');
      return;
    }
    const fenetre = reglages?.form_window_size || 5;
    const formeGlobale = formeDepuisMatchs(
      derniers.filter((m) => m.score_home !== null), teamId, fenetre);

    const posParLigue = new Map();
    for (const p of positions) {
      if (!posParLigue.has(p.league_id)) posParLigue.set(p.league_id, p);
    }
    const rangs = [...posParLigue.values()].map((p) => `
      <a class="lien-classement" href="#/classement/${p.league_id}">
        ${echapper(p.league?.name)} : ${echapper(ordinal(p.position))}</a>`).join(' · ');

    conteneur.innerHTML = `
      <div class="carte centre">
        <div style="display:flex;justify-content:center;margin-bottom:.5rem">
          ${blason(equipe)}</div>
        <h1 style="margin:.2rem 0">${echapper(equipe.name)}</h1>
        <p class="faible">${equipe.sport === 'rugby' ? '🏉 Rugby' : '⚽ Football'}
          · Elo <strong>${nombre(equipe.rating, 1)}</strong>
          · ${nombre(equipe.matches_played)} matchs</p>
        ${rangs ? `<p>🏆 ${rangs}</p>` : ''}
      </div>

      <div class="carte">
        <h2 style="margin-top:0">Vue d'ensemble</h2>
        ${globales ? `
          <div class="grille-stats">
            <div><span class="valeur">${nombre(globales.matches_played)}</span>matchs</div>
            <div><span class="valeur">${nombre(globales.wins)}</span>victoires</div>
            <div><span class="valeur">${nombre(globales.draws)}</span>nuls</div>
            <div><span class="valeur">${nombre(globales.losses)}</span>défaites</div>
            <div><span class="valeur">${nombre(globales.score_for)}</span>marqués</div>
            <div><span class="valeur">${nombre(globales.score_against)}</span>encaissés</div>
          </div>
          <p class="faible">Forme récente</p><p>${badgesForme(formeGlobale)}</p>`
        : '<p class="muet">Aucun match terminé pour le moment.</p>'}
      </div>

      ${parCompetition.length ? `<h2>Par compétition</h2>
        ${parCompetition.map((s) => carteCompetition(s, posParLigue)).join('')}` : ''}

      ${derniers.length ? `<h2>Derniers matchs</h2>
        ${derniers.map((m) => ligneMatch(m, teamId)).join('')}` : ''}

      ${prochains.length ? `<h2>Prochains matchs</h2>
        ${prochains.map((m) => ligneMatch(m, teamId)).join('')}` : ''}`;
  } catch (e) {
    conteneur.innerHTML = erreur(e);
  }
}

function carteCompetition(s, posParLigue) {
  const rang = posParLigue.get(s.league_id);
  let ligneRang = '';
  if (rang) {
    ligneRang = `<p><a class="lien-classement" href="#/classement/${s.league_id}">
      🏆 ${echapper(ordinal(rang.position))} · ${nombre(rang.points)} pts
      · voir le tableau</a></p>`;
  } else if (s.league?.category === 'championnat') {
    ligneRang = `<p><a class="lien-classement" href="${lienClassementExterne(s.league)}"
      target="_blank" rel="noopener">🔗 Classement officiel</a></p>`;
  }
  return `
    <details class="carte">
      <summary>
        <strong>${echapper(s.league?.name)}</strong>
        <span class="faible">${nombre(s.wins)}V ${nombre(s.draws)}N ${nombre(s.losses)}D
          ${s.current_streak ? `· ${echapper(s.current_streak)}` : ''}</span>
      </summary>
      ${ligneRang}
      <div class="tableau-camps">
        <div><h3>Total</h3>
          <p>${nombre(s.wins)}V ${nombre(s.draws)}N ${nombre(s.losses)}D</p>
          <p class="faible">${nombre(s.score_for)} / ${nombre(s.score_against)}</p></div>
        <div><h3>Domicile</h3>
          <p>${nombre(s.home_wins)}V ${nombre(s.home_draws)}N ${nombre(s.home_losses)}D</p>
          <p class="faible">${nombre(s.home_score_for)} / ${nombre(s.home_score_against)}</p></div>
        <div><h3>Extérieur</h3>
          <p>${nombre(s.away_wins)}V ${nombre(s.away_draws)}N ${nombre(s.away_losses)}D</p>
          <p class="faible">${nombre(s.away_score_for)} / ${nombre(s.away_score_against)}</p></div>
      </div>
      <p class="faible">Forme dans la compétition</p>
      <p>${badgesForme(s.last_results)}</p>
    </details>`;
}

function ligneMatch(m, teamId) {
  const termine = m.status === 'finished' && m.score_home !== null;
  return `
    <a class="carte" href="#/match/${m.id}">
      <div class="match-entete">
        <span class="competition">${echapper(m.league?.name)}</span>
        <span>${dateHeure(m.kickoff_at)}</span>
      </div>
      <div class="match-corps">
        <span class="faible centre ${m.home_team_id === teamId ? 'gras' : ''}">
          ${echapper(m.home?.name)}</span>
        <div class="cases-score">
          <div class="score-fige">${termine ? m.score_home : '?'}</div>
          <span class="deux-points">:</span>
          <div class="score-fige">${termine ? m.score_away : '?'}</div>
        </div>
        <span class="faible centre ${m.away_team_id === teamId ? 'gras' : ''}">
          ${echapper(m.away?.name)}</span>
      </div>
    </a>`;
}
