// Page équipe (section 7.1) : en-tête, vue d'ensemble globale, cartes par
// compétition (dépliables), derniers matchs, prochains matchs.

import {
  lireEquipe, lireReglages, matchsEquipe, positionsEquipe, statsGlobales,
  statsParCompetition,
} from '../api.js';
import {
  badgesForme, chargement, dateHeure, echapper, erreur, formeDepuisMatchs,
  lienClassementExterne, nombre, ordinal,
} from '../ui.js';

export async function pageEquipe(conteneur, teamId) {
  conteneur.innerHTML = chargement();
  try {
    const [equipe, globales, parCompetition, reglages, derniers, prochains,
           positions] = await Promise.all([
        lireEquipe(teamId),
        statsGlobales(teamId),
        statsParCompetition(teamId),
        lireReglages(),
        matchsEquipe(teamId, { statut: 'finished', limite: 15 }),
        matchsEquipe(teamId, { statut: 'scheduled', limite: 10 }),
        positionsEquipe(teamId),
      ]);
    if (!equipe) {
      conteneur.innerHTML = '<p class="erreur">Équipe introuvable.</p>';
      return;
    }
    const fenetre = reglages?.form_window_size || 5;
    const formeGlobale = formeDepuisMatchs(
      derniers.filter((m) => m.score_home !== null), teamId, fenetre);

    // Position par championnat (saison la plus récente par ligue)
    const posParLigue = new Map();
    for (const p of positions) {
      if (!posParLigue.has(p.league_id)) posParLigue.set(p.league_id, p);
    }
    const lignesClassement = [...posParLigue.values()].map((p) => `
      <a class="lien-classement" href="#/classement/${p.league_id}">
        ${echapper(p.league?.name)} : ${echapper(ordinal(p.position))}
        (${nombre(p.points)} pts)</a>`).join(' · ');

    conteneur.innerHTML = `
      <header class="entete-page">
        <h1>${echapper(equipe.name)}</h1>
        <p class="muet">${equipe.sport === 'rugby' ? '🏉 Rugby' : '⚽ Football'}
          · Rating Elo <strong>${nombre(equipe.rating, 1)}</strong>
          · ${nombre(equipe.matches_played)} matchs pris en compte</p>
        ${lignesClassement ? `<p>🏆 ${lignesClassement}</p>` : ''}
      </header>

      <section class="carte">
        <h2>Vue d'ensemble</h2>
        ${globales ? `
        <div class="grille-stats">
          <div><span class="valeur">${nombre(globales.matches_played)}</span> matchs</div>
          <div><span class="valeur">${nombre(globales.wins)}</span> V</div>
          <div><span class="valeur">${nombre(globales.draws)}</span> N</div>
          <div><span class="valeur">${nombre(globales.losses)}</span> D</div>
          <div><span class="valeur">${nombre(globales.score_for)}</span> marqués</div>
          <div><span class="valeur">${nombre(globales.score_against)}</span> encaissés</div>
        </div>
        <p>Forme récente globale : ${badgesForme(formeGlobale)}</p>
        ` : '<p class="muet">Aucun match terminé pour le moment (démarrage à froid).</p>'}
      </section>

      <section>
        <h2>Par compétition</h2>
        ${parCompetition.length === 0
          ? '<p class="muet">Aucune compétition disputée.</p>'
          : parCompetition.map((s) => carteCompetition(s, posParLigue)).join('')}
      </section>

      <section>
        <h2>Derniers matchs</h2>
        ${derniers.length === 0 ? '<p class="muet">Aucun match terminé.</p>'
          : derniers.map((m) => ligneMatch(m, teamId)).join('')}
      </section>

      <section>
        <h2>Prochains matchs</h2>
        ${prochains.length === 0 ? '<p class="muet">Aucun match programmé dans la fenêtre synchronisée.</p>'
          : prochains.map((m) => ligneMatch(m, teamId)).join('')}
      </section>`;
  } catch (e) {
    conteneur.innerHTML = erreur(e);
  }
}

function carteCompetition(s, posParLigue) {
  const rang = posParLigue.get(s.league_id);
  let ligneRang = '';
  if (rang) {
    ligneRang = `<p><a class="lien-classement" href="#/classement/${s.league_id}">
      🏆 ${echapper(ordinal(rang.position))} du classement (${nombre(rang.points)} pts)
      · voir le tableau complet</a></p>`;
  } else if (s.league?.category === 'championnat') {
    // Championnat sans classement encore synchronisé : lien de secours
    ligneRang = `<p><a class="lien-classement" href="${lienClassementExterne(s.league)}"
      target="_blank" rel="noopener">🔗 Classement officiel (recherche externe)</a></p>`;
  }
  return `
    <details class="carte">
      <summary>
        <strong>${echapper(s.league?.name)}</strong>
        <span class="muet">${nombre(s.matches_played)} matchs ·
          ${nombre(s.wins)}V ${nombre(s.draws)}N ${nombre(s.losses)}D
          ${s.current_streak ? `· série ${echapper(s.current_streak)}` : ''}</span>
      </summary>
      ${ligneRang}
      <div class="tableau-camps">
        <div>
          <h3>Total</h3>
          <p>${nombre(s.wins)}V ${nombre(s.draws)}N ${nombre(s.losses)}D</p>
          <p class="muet">${nombre(s.score_for)} marqués / ${nombre(s.score_against)} encaissés</p>
        </div>
        <div>
          <h3>Domicile</h3>
          <p>${nombre(s.home_wins)}V ${nombre(s.home_draws)}N ${nombre(s.home_losses)}D</p>
          <p class="muet">${nombre(s.home_score_for)} / ${nombre(s.home_score_against)}</p>
        </div>
        <div>
          <h3>Extérieur</h3>
          <p>${nombre(s.away_wins)}V ${nombre(s.away_draws)}N ${nombre(s.away_losses)}D</p>
          <p class="muet">${nombre(s.away_score_for)} / ${nombre(s.away_score_against)}</p>
        </div>
      </div>
      <p>Forme dans cette compétition : ${badgesForme(s.last_results)}</p>
    </details>`;
}

function ligneMatch(m, teamId) {
  const termine = m.status === 'finished';
  return `
    <a class="carte carte-match" href="#/match/${m.id}">
      <div class="carte-match-entete">
        <span class="muet">${echapper(m.league?.name)} · ${dateHeure(m.kickoff_at)}</span>
      </div>
      <div class="carte-match-equipes">
        <span class="${m.home_team_id === teamId ? 'gras' : ''}">${echapper(m.home?.name)}</span>
        <span class="${termine ? 'score' : 'muet'}">${termine
          ? `${m.score_home ?? '?'} - ${m.score_away ?? '?'}` : 'vs'}</span>
        <span class="${m.away_team_id === teamId ? 'gras' : ''}">${echapper(m.away?.name)}</span>
      </div>
    </a>`;
}
