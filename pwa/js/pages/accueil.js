// Page Paris : un jour à la fois (sélecteur de dates horizontal), cartes
// « blason · score · blason » façon MPP.
//   - match à venir : les cases sont modifiables à volonté, le pronostic
//     est enregistré en brouillon et validé au coup d'envoi
//   - match commencé ou joué : score figé, pronostic et gain rappelés

import {
  brouillonsSurMatchs, dernieresCotes, listeLigues, lireReglages,
  matchsDuJour, mesParisSurMatchs,
} from '../api.js';
import { brancherCases, casesScore } from '../saisie.js';
import {
  blason, cleJour, echapper, eclats, erreur, gainPari, heure, libelleBonus,
  nombre, squelettes, vide,
} from '../ui.js';

const JOURS_AVANT = 3;
const JOURS_APRES = 9;

const etat = { date: null, sport: '', leagueId: '' };
let liguesCache = null;

export async function pageAccueil(conteneur) {
  etat.date = etat.date || cleJour(new Date().toISOString());
  conteneur.innerHTML = squelettes(3);
  try {
    liguesCache = liguesCache || await listeLigues();
    await rendre(conteneur);
  } catch (e) {
    conteneur.innerHTML = erreur(e);
  }
}

function bandeauDates() {
  const base = new Date();
  const puces = [];
  for (let d = -JOURS_AVANT; d <= JOURS_APRES; d += 1) {
    const jour = new Date(base.getTime() + d * 86400000);
    const cle = cleJour(jour.toISOString());
    const libelle = jour.toLocaleDateString('fr-FR', { weekday: 'short' })
      .replace('.', '');
    puces.push(`
      <button class="puce-date ${cle === etat.date ? 'actif' : ''}
                    ${d === 0 ? 'aujourdhui' : ''}" data-date="${cle}">
        <span>${echapper(libelle)}</span>
        <span class="num">${jour.getDate()}</span>
      </button>`);
  }
  return `<div class="bandeau-dates">${puces.join('')}</div>`;
}

function bandeauFiltres() {
  const puces = [
    `<button class="puce ${!etat.sport && !etat.leagueId ? 'actif' : ''}" data-sport="">Tous</button>`,
    `<button class="puce ${etat.sport === 'football' ? 'actif' : ''}" data-sport="football">⚽ Foot</button>`,
    `<button class="puce ${etat.sport === 'rugby' ? 'actif' : ''}" data-sport="rugby">🏉 Rugby</button>`,
  ];
  for (const l of (liguesCache || []).filter(
    (l) => !etat.sport || l.sport === etat.sport)) {
    puces.push(`<button class="puce ${etat.leagueId === l.id ? 'actif' : ''}"
      data-ligue="${l.id}">${echapper(l.name)}</button>`);
  }
  return `<div class="filtres">${puces.join('')}</div>`;
}

async function rendre(conteneur) {
  conteneur.innerHTML = `${bandeauDates()}${bandeauFiltres()}${squelettes(3)}`;
  brancherBandeaux(conteneur);

  const [matchs, reglages] = await Promise.all([
    matchsDuJour(etat.date, {
      sport: etat.sport || undefined,
      leagueId: etat.leagueId || undefined,
    }),
    lireReglages(),
  ]);
  const ids = matchs.map((m) => m.id);
  const [cotes, paris, brouillons] = await Promise.all([
    dernieresCotes(ids), mesParisSurMatchs(ids), brouillonsSurMatchs(ids),
  ]);
  const mise = Number(reglages?.default_stake) || 100;

  const liste = matchs.length
    ? matchs.map((m) => carteMatch(
        m, cotes.get(m.id), paris.get(m.id) || [], brouillons.get(m.id))).join('')
    : vide('📅', 'Aucun match ce jour',
        'Change de date ou de compétition avec les filtres ci-dessus.');

  conteneur.innerHTML = `
    ${bandeauDates()}
    ${bandeauFiltres()}
    <p class="faible centre">Ton score est enregistré au fil de la saisie
      et modifiable jusqu'au coup d'envoi, où il devient un pari de
      <strong>${eclats(mise)} ✦</strong>.</p>
    ${liste}`;
  brancherBandeaux(conteneur);
  brancherSaisies(conteneur, mise);
}

function brancherBandeaux(conteneur) {
  conteneur.querySelectorAll('.puce-date').forEach((b) => {
    b.addEventListener('click', () => { etat.date = b.dataset.date; rendre(conteneur); });
  });
  conteneur.querySelectorAll('.puce[data-sport]').forEach((b) => {
    b.addEventListener('click', () => {
      etat.sport = b.dataset.sport; etat.leagueId = ''; rendre(conteneur);
    });
  });
  conteneur.querySelectorAll('.puce[data-ligue]').forEach((b) => {
    b.addEventListener('click', () => {
      etat.leagueId = etat.leagueId === b.dataset.ligue ? '' : b.dataset.ligue;
      rendre(conteneur);
    });
  });
  const active = conteneur.querySelector('.puce-date.actif');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function issueDe(h, a) {
  if (h > a) return 'home';
  return h < a ? 'away' : 'draw';
}

function carteMatch(m, cote, parisDuMatch, brouillon) {
  const ouvert = m.status === 'scheduled' && new Date(m.kickoff_at) > new Date();
  const termine = m.status === 'finished' && m.score_home !== null;
  const enCours = m.status === 'live';
  const pari = parisDuMatch[0];
  const pronostic = pari || brouillon;

  const issuePronostic = pronostic
    ? issueDe(pronostic.predicted_home, pronostic.predicted_away) : null;
  const cotesMini = cote ? `
    <div class="cotes-mini">
      <span class="${issuePronostic === 'home' ? 'choisi' : ''}">${nombre(cote.home_odds, 2)}</span>
      ${cote.draw_odds ? `<span class="${issuePronostic === 'draw' ? 'choisi' : ''}">${nombre(cote.draw_odds, 2)}</span>` : ''}
      <span class="${issuePronostic === 'away' ? 'choisi' : ''}">${nombre(cote.away_odds, 2)}</span>
    </div>` : '';

  const centre = ouvert
    ? casesScore(m, brouillon)
    : `<div class="cases-score">
         <div class="score-fige">${termine || enCours ? m.score_home ?? '?' : '?'}</div>
         <span class="deux-points">:</span>
         <div class="score-fige">${termine || enCours ? m.score_away ?? '?' : '?'}</div>
       </div>`;

  return `
    <div class="carte carte-match" data-match="${m.id}">
      <div class="match-entete">
        <a class="competition" href="#/match/${m.id}">
          ${m.league?.sport === 'rugby' ? '🏉' : '⚽'} ${echapper(m.league?.name || '')}
        </a>
        <span>${etiquetteStatut(m)}</span>
      </div>
      <div class="match-corps">
        <a class="equipe" href="#/equipe/${m.home_team_id}">
          ${blason(m.home)}<span class="nom">${echapper(m.home?.name)}</span>
        </a>
        <div class="bloc-score">${centre}${cotesMini}</div>
        <a class="equipe" href="#/equipe/${m.away_team_id}">
          ${blason(m.away)}<span class="nom">${echapper(m.away?.name)}</span>
        </a>
      </div>
      ${piedCarte(m, pari, brouillon, parisDuMatch, termine, ouvert)}
    </div>`;
}

function etiquetteStatut(m) {
  if (m.status === 'live') return '<span style="color:var(--rouge)">● en direct</span>';
  if (m.status === 'finished') return 'terminé';
  if (m.status === 'postponed') return 'reporté';
  if (m.status === 'cancelled') return 'annulé';
  return heure(m.kickoff_at);
}

function piedCarte(m, pari, brouillon, parisDuMatch, termine, ouvert) {
  // Match à venir : état de l'enregistrement du brouillon
  if (ouvert) {
    return `
      <div class="match-pied">
        <span class="etat-saisie faible">${brouillon
          ? `Enregistré : ${brouillon.predicted_home} - ${brouillon.predicted_away}`
          : 'Saisis ton pronostic'}</span>
        <a class="lien-classement" href="#/match/${m.id}">Détails et mise →</a>
      </div>`;
  }
  if (!pari) {
    return `
      <div class="match-pied">
        <span class="faible">${brouillon
          ? `Pronostic ${brouillon.predicted_home} - ${brouillon.predicted_away} en cours de validation`
          : 'Pas de pronostic'}</span>
        <a class="lien-classement" href="#/match/${m.id}">Détails →</a>
      </div>`;
  }
  const autres = parisDuMatch.length > 1
    ? ` <span class="faible">+${parisDuMatch.length - 1}</span>` : '';
  let pastille;
  if (pari.status === 'won') {
    pastille = `<span class="gain-pastille ${pari.collected_at ? 'gagne' : 'collecte'}">
      ${pari.collected_at ? '' : '✦ '}+${eclats(gainPari(pari))} ✦</span>`;
  } else if (pari.status === 'lost') {
    pastille = '<span class="gain-pastille perdu">perdu</span>';
  } else if (pari.status === 'void') {
    pastille = `<span class="gain-pastille attente">remboursé ${eclats(pari.stake_eclats)} ✦</span>`;
  } else {
    pastille = `<span class="gain-pastille attente">${eclats(pari.stake_eclats)} ✦ en jeu</span>`;
  }
  return `
    <div class="match-pied">
      <div>
        <div class="libelle">Pari validé${autres}</div>
        <div class="valeur">${pari.predicted_home} - ${pari.predicted_away}
          ${termine && pari.status === 'won'
            ? `<span class="faible">· ${echapper(libelleBonus(pari, m.score_home, m.score_away))}</span>`
            : ''}</div>
      </div>
      ${pastille}
    </div>`;
}

function brancherSaisies(conteneur, mise) {
  for (const carte of conteneur.querySelectorAll('.carte-match')) {
    const etatSaisie = carte.querySelector('.etat-saisie');
    brancherCases(carte, {
      mise,
      surEtat: (texte, classe) => {
        if (etatSaisie) {
          etatSaisie.textContent = texte;
          etatSaisie.className = `etat-saisie ${classe === 'ok' ? 'ok' : classe}`;
        }
      },
    });
  }
}
