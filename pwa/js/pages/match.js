// Page match (sections 7.2 et 7.3) : même route, contenu selon status.
// - scheduled : cotes + pari, bloc comparatif, confrontations directes
// - finished  : score final, mes paris sur ce match, bloc comparatif figé
//   "avant le match" (recalculé depuis l'historique antérieur au coup
//   d'envoi, et cotes = dernières générées avant le kickoff)

import {
  confrontations, dernieresCotes, lireMatch, lireReglages, matchsEquipe,
  mesParisSurMatch, placerPari, positionsDansLigue, statsCompetition,
  statsGlobales,
} from '../api.js';
import {
  badgesForme, chargement, dateHeure, echapper, erreur, formeDepuisMatchs,
  libelleBonus, nombre, ordinal, probaImplicite,
} from '../ui.js';

const SELECTIONS = { home: '1 (domicile)', draw: 'Nul', away: '2 (extérieur)' };
const STATUTS = {
  live: 'Match en cours — paris fermés',
  postponed: 'Match reporté — paris remboursés',
  cancelled: 'Match annulé — paris remboursés',
};

export async function pageMatch(conteneur, matchId) {
  conteneur.innerHTML = chargement();
  try {
    const match = await lireMatch(matchId);
    if (!match) {
      conteneur.innerHTML = '<p class="erreur">Match introuvable.</p>';
      return;
    }
    if (match.status === 'finished') await renduTermine(conteneur, match);
    else if (match.status === 'scheduled') await renduAVenir(conteneur, match);
    else await renduAutre(conteneur, match);
  } catch (e) {
    conteneur.innerHTML = erreur(e);
  }
}

function entete(match, sousTitre) {
  const lienClassement = match.league?.category === 'championnat'
    ? ` · <a class="lien-classement" href="#/classement/${match.league_id}">Classement</a>`
    : '';
  return `
    <header class="entete-page">
      <p class="muet">${echapper(match.league?.name)} · ${dateHeure(match.kickoff_at)}${lienClassement}</p>
      <h1 class="affiche">
        <a href="#/equipe/${match.home_team_id}">${echapper(match.home?.name)}</a>
        <span class="muet">${sousTitre}</span>
        <a href="#/equipe/${match.away_team_id}">${echapper(match.away?.name)}</a>
      </h1>
    </header>`;
}

// ---------- Match à venir (7.2) ----------

async function renduAVenir(conteneur, match) {
  const [cotesParMatch, reglages] = await Promise.all([
    dernieresCotes([match.id]), lireReglages(),
  ]);
  const cotes = cotesParMatch.get(match.id);

  conteneur.innerHTML = `
    ${entete(match, 'vs')}
    <section class="carte" id="zone-pari">
      <h2>Parier sur le score</h2>
      ${cotes ? formulairePari(match, cotes)
              : '<p class="muet">Cotes pas encore générées (prochain run de sync).</p>'}
    </section>
    <section id="zone-comparatif">${chargement()}</section>
    <section id="zone-h2h">${chargement()}</section>`;

  if (cotes) brancherPari(conteneur, match, cotes, reglages);

  const [comparatif, h2h] = await Promise.all([
    blocComparatif(match, cotes, null),
    confrontations(match.home_team_id, match.away_team_id),
  ]);
  conteneur.querySelector('#zone-comparatif').innerHTML = comparatif;
  conteneur.querySelector('#zone-h2h').innerHTML = blocH2H(h2h);
  brancherVoirPlus(conteneur);
}

function formulairePari(match, cotes) {
  return `
    <form id="formulaire-pari">
      <div class="rangee-cotes info-cotes">
        <span>1 · ${nombre(cotes.home_odds, 2)}</span>
        ${cotes.draw_odds ? `<span>N · ${nombre(cotes.draw_odds, 2)}</span>` : ''}
        <span>2 · ${nombre(cotes.away_odds, 2)}</span>
      </div>
      <div class="rangee-score">
        <label>${echapper(match.home?.name)}
          <input type="number" name="ph" min="0" max="199" step="1" inputmode="numeric" required></label>
        <span class="tiret">–</span>
        <label>${echapper(match.away?.name)}
          <input type="number" name="pa" min="0" max="199" step="1" inputmode="numeric" required></label>
      </div>
      <div class="rangee-mise">
        <label>Mise <input type="number" name="mise" min="1" step="1" placeholder="Éclats" required></label>
        <button type="submit">Placer le pari</button>
      </div>
      <p id="apercu-pari" class="muet"></p>
      <p id="retour-pari" class="muet"></p>
    </form>`;
}

function brancherPari(conteneur, match, cotes, reglages) {
  const formulaire = conteneur.querySelector('#formulaire-pari');
  const retour = conteneur.querySelector('#retour-pari');
  const apercu = conteneur.querySelector('#apercu-pari');
  const bonusEcart = Number(reglages?.bonus_ecart) || 1.5;
  const bonusEcartNul = Number(reglages?.bonus_ecart_nul) || 1.25;
  const bonusExact = Number(reglages?.bonus_score_exact) || 2;

  const lireChamps = () => {
    const d = new FormData(formulaire);
    const ph = d.get('ph'), pa = d.get('pa');
    return {
      ph: ph === '' ? null : Number(ph),
      pa: pa === '' ? null : Number(pa),
      mise: Number(d.get('mise')) || 0,
    };
  };

  formulaire.addEventListener('input', () => {
    const { ph, pa, mise } = lireChamps();
    if (ph === null || pa === null) { apercu.textContent = ''; return; }
    const selection = ph > pa ? 'home' : ph < pa ? 'away' : 'draw';
    const cote = selection === 'home' ? cotes.home_odds
      : selection === 'away' ? cotes.away_odds : cotes.draw_odds;
    if (cote == null) { apercu.textContent = 'Cote indisponible pour cette issue.'; return; }
    const base = (mise || 0) * Number(cote);
    const gains = mise > 0 ? (selection === 'draw'
      ? ` — gain : ${nombre(base * bonusEcartNul, 2)} ✦ (bon écart d'office, bonus nul réduit ×${nombre(bonusEcartNul, 2)}) · score exact : ${nombre(base * bonusExact, 2)} ✦ (×${nombre(bonusExact, 1)})`
      : ` — gain : ${nombre(base, 2)} ✦ · bon écart : ${nombre(base * bonusEcart, 2)} ✦ (×${nombre(bonusEcart, 1)}) · score exact : ${nombre(base * bonusExact, 2)} ✦ (×${nombre(bonusExact, 1)})`)
      : '';
    apercu.textContent = `Issue : ${SELECTIONS[selection]} (cote ${nombre(cote, 2)})${gains}`;
  });

  formulaire.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    const { ph, pa, mise } = lireChamps();
    if (ph === null || pa === null) {
      retour.textContent = 'Indiquer un score pronostiqué.';
      return;
    }
    retour.textContent = 'Placement en cours…';
    try {
      await placerPari(match.id, ph, pa, mise);
      retour.textContent = `Pari placé (${ph}–${pa}) ! Visible dans Mes paris.`;
      window.dispatchEvent(new Event('eclats-changes'));
      formulaire.reset();
      apercu.textContent = '';
    } catch (e) {
      retour.textContent = `Refusé : ${e.message}`;
    }
  });
}

// ---------- Match terminé (7.3) ----------

async function renduTermine(conteneur, match) {
  const [cotesAvant, paris] = await Promise.all([
    dernieresCotes([match.id], match.kickoff_at),
    mesParisSurMatch(match.id),
  ]);
  const cotes = cotesAvant.get(match.id);
  const LIBELLES = { pending: 'En cours', won: 'Gagné', lost: 'Perdu', void: 'Remboursé' };

  conteneur.innerHTML = `
    ${entete(match, `${match.score_home ?? '?'} – ${match.score_away ?? '?'}`)}
    <section class="carte">
      <h2>Mes paris sur ce match</h2>
      ${paris.length === 0 ? '<p class="muet">Aucun pari placé sur ce match.</p>'
        : paris.map((p) => `
          <p class="statut-${p.status}">
            Pronostic <strong>${echapper(p.predicted_home)}–${echapper(p.predicted_away)}</strong>
            (${echapper(SELECTIONS[p.selection] || p.selection)}) ·
            mise ${nombre(p.stake_eclats)} ✦ · cote ${nombre(p.odds_at_bet, 2)}
            → <strong>${LIBELLES[p.status] || echapper(p.status)}</strong>
            ${p.status === 'won' ? `: +${nombre(p.potential_payout * (p.bonus_multiplier || 1), 2)} ✦
              <span class="muet">(${nombre(p.potential_payout, 2)} ✦ —
              ${echapper(libelleBonus(p, match.score_home, match.score_away))})</span>` : ''}
          </p>`).join('')}
    </section>
    <section id="zone-comparatif">${chargement()}</section>
    <section id="zone-h2h">${chargement()}</section>`;

  const [comparatif, h2h] = await Promise.all([
    blocComparatif(match, cotes, match.kickoff_at),
    confrontations(match.home_team_id, match.away_team_id),
  ]);
  conteneur.querySelector('#zone-comparatif').innerHTML = `
    <p class="muet">⏱ C'était la situation avant le match — les statistiques
    ci-dessous sont figées à l'avant-match, pas recalculées après.</p>
    ${comparatif}`;
  conteneur.querySelector('#zone-h2h').innerHTML = blocH2H(h2h, match.id);
  brancherVoirPlus(conteneur);
}

async function renduAutre(conteneur, match) {
  conteneur.innerHTML = `
    ${entete(match, match.status === 'live' ? '⚡' : '—')}
    <p class="pastille">${echapper(STATUTS[match.status] || match.status)}</p>`;
}

// ---------- Bloc comparatif (7.2 point 3 / 7.3) ----------

function statsDepuisMatchs(matchs, teamId) {
  const s = { mp: 0, v: 0, n: 0, d: 0, sf: 0, sc: 0 };
  for (const m of matchs) {
    if (m.score_home === null || m.score_away === null) continue;
    const estDomicile = m.home_team_id === teamId;
    const [gf, ga] = estDomicile
      ? [m.score_home, m.score_away] : [m.score_away, m.score_home];
    s.mp += 1; s.sf += gf; s.sc += ga;
    if (gf > ga) s.v += 1; else if (gf < ga) s.d += 1; else s.n += 1;
  }
  return s;
}

const moyenne = (somme, total) => total ? nombre(somme / total, 1) : '—';

async function blocComparatif(match, cotes, avant) {
  const fenetre = (await lireReglages())?.form_window_size || 5;
  // Position au classement (championnats uniquement — classement actuel,
  // pas historisé à l'avant-match)
  const positions = match.league?.category === 'championnat'
    ? await positionsDansLigue(match.league_id,
        [match.home_team_id, match.away_team_id])
    : new Map();
  const equipes = [
    { id: match.home_team_id, nom: match.home?.name, rating: match.home?.rating,
      camp: 'home', libelleCamp: 'domicile' },
    { id: match.away_team_id, nom: match.away?.name, rating: match.away?.rating,
      camp: 'away', libelleCamp: 'extérieur' },
  ];

  const colonnes = await Promise.all(equipes.map(async (e) => {
    const tous = await matchsEquipe(e.id, { statut: 'finished', avant, limite: 50 });
    const dansCompet = tous.filter((m) => m.league_id === match.league_id);
    const duCamp = tous.filter((m) => (e.camp === 'home'
      ? m.home_team_id === e.id : m.away_team_id === e.id));

    // Moyennes : stats stockées pour un match à venir, recalcul historique
    // pour la vue avant-match d'un match terminé
    let global, compet;
    if (avant) {
      global = statsDepuisMatchs(tous, e.id);
      compet = statsDepuisMatchs(dansCompet, e.id);
    } else {
      const [g, c] = await Promise.all([
        statsGlobales(e.id), statsCompetition(e.id, match.league_id)]);
      global = g ? { mp: g.matches_played, sf: g.score_for, sc: g.score_against }
                 : { mp: 0, sf: 0, sc: 0 };
      compet = c ? { mp: c.matches_played, sf: c.score_for, sc: c.score_against }
                 : { mp: 0, sf: 0, sc: 0 };
    }

    const coteEquipe = cotes
      ? (e.camp === 'home' ? cotes.home_odds : cotes.away_odds) : null;
    const rang = positions.get(e.id);
    return `
      <div class="colonne-equipe">
        <h3><a href="#/equipe/${e.id}">${echapper(e.nom)}</a></h3>
        ${rang ? `<p><a class="lien-classement" href="#/classement/${match.league_id}">
          ${echapper(ordinal(rang.position))} du championnat
          (${nombre(rang.points)} pts)</a></p>` : ''}
        <p>Elo <strong>${nombre(e.rating, 1)}</strong>
          · proba implicite ${probaImplicite(coteEquipe)}</p>
        <p>Forme globale<br>${badgesForme(formeDepuisMatchs(tous, e.id, fenetre))}</p>
        <p>Forme dans cette compétition<br>${badgesForme(formeDepuisMatchs(dansCompet, e.id, fenetre))}</p>
        <p>Forme à ${e.libelleCamp}<br>${badgesForme(formeDepuisMatchs(duCamp, e.id, fenetre))}</p>
        <p class="muet">Moy. marqués/encaissés<br>
          global : ${moyenne(global.sf, global.mp)} / ${moyenne(global.sc, global.mp)}<br>
          compétition : ${moyenne(compet.sf, compet.mp)} / ${moyenne(compet.sc, compet.mp)}</p>
      </div>`;
  }));

  return `
    <h2>Face à face</h2>
    <div class="comparatif carte">${colonnes.join('')}</div>`;
}

// ---------- Confrontations directes (7.2 point 4) ----------

function blocH2H(rencontres, matchIdCourant) {
  const liste = rencontres.filter((m) => m.id !== matchIdCourant);
  if (!liste.length) {
    return '<h2>Confrontations directes</h2><p class="muet">Aucune confrontation enregistrée.</p>';
  }
  const ligne = (m) => `
    <a class="carte carte-match" href="#/match/${m.id}">
      <div class="carte-match-entete">
        <span class="muet">${echapper(m.league?.name)} · ${dateHeure(m.kickoff_at)}</span>
      </div>
      <div class="carte-match-equipes">
        <span>${echapper(m.home?.name)}</span>
        <span class="score">${m.score_home ?? '?'} – ${m.score_away ?? '?'}</span>
        <span>${echapper(m.away?.name)}</span>
      </div>
    </a>`;
  const visibles = liste.slice(0, 10).map(ligne).join('');
  const masques = liste.slice(10).map(ligne).join('');
  return `
    <h2>Confrontations directes</h2>
    ${visibles}
    ${masques ? `
      <div id="h2h-plus" hidden>${masques}</div>
      <button type="button" id="bouton-h2h-plus" class="secondaire">
        Voir plus (${liste.length - 10})</button>` : ''}`;
}

function brancherVoirPlus(conteneur) {
  const bouton = conteneur.querySelector('#bouton-h2h-plus');
  if (bouton) {
    bouton.addEventListener('click', () => {
      conteneur.querySelector('#h2h-plus').hidden = false;
      bouton.remove();
    });
  }
}
