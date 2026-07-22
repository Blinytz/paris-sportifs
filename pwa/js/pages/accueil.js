// Page Paris : un jour à la fois (sélecteur de dates horizontal), cartes
// « logo · score · logo » façon MPP.
//   - match à venir  : les deux cases sont saisissables, le pari part tout
//     seul avec la mise par défaut dès qu'elles sont remplies
//   - match joué     : score figé, pronostic et gain rappelés dessous

import {
  dernieresCotes, listeLigues, lireReglages, matchsDuJour,
  mesParisSurMatchs, placerPari,
} from '../api.js';
import {
  blason, cleJour, echapper, eclats, erreur, gainPari, heure, libelleBonus,
  nombre, squelettes, toast, vibrer, vide,
} from '../ui.js';

const DELAI_ENVOI = 1200;   // laisse le temps de saisir un score à 2 chiffres
const JOURS_AVANT = 3;      // profondeur du sélecteur de dates
const JOURS_APRES = 9;      // fenêtre synchronisée par le sync

const etat = { date: null, sport: '', leagueId: '' };
let liguesCache = null;

function aujourdhui() {
  const d = new Date();
  return cleJour(d.toISOString());
}

export async function pageAccueil(conteneur) {
  etat.date = etat.date || aujourdhui();
  conteneur.innerHTML = `<div class="bandeau-dates"></div>${squelettes(3)}`;
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
  const ligues = (liguesCache || []).filter(
    (l) => !etat.sport || l.sport === etat.sport);
  for (const l of ligues) {
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
  const [cotes, paris] = await Promise.all([
    dernieresCotes(ids), mesParisSurMatchs(ids),
  ]);
  const mise = Number(reglages?.default_stake) || 100;

  const liste = matchs.length
    ? matchs.map((m) => carteMatch(m, cotes.get(m.id), paris.get(m.id) || [])).join('')
    : vide('📅', 'Aucun match ce jour',
        'Change de date ou de compétition avec les filtres ci-dessus.');

  conteneur.innerHTML = `
    ${bandeauDates()}
    ${bandeauFiltres()}
    <p class="faible centre">Saisis un score : la mise de
      <strong>${eclats(mise)} ✦</strong> part toute seule.</p>
    ${liste}`;
  brancherBandeaux(conteneur);
  brancherSaisie(conteneur, mise);
}

function brancherBandeaux(conteneur) {
  conteneur.querySelectorAll('.puce-date').forEach((b) => {
    b.addEventListener('click', () => {
      etat.date = b.dataset.date;
      rendre(conteneur);
    });
  });
  conteneur.querySelectorAll('.puce[data-sport]').forEach((b) => {
    b.addEventListener('click', () => {
      etat.sport = b.dataset.sport;
      etat.leagueId = '';
      rendre(conteneur);
    });
  });
  conteneur.querySelectorAll('.puce[data-ligue]').forEach((b) => {
    b.addEventListener('click', () => {
      etat.leagueId = etat.leagueId === b.dataset.ligue ? '' : b.dataset.ligue;
      rendre(conteneur);
    });
  });
  // Garde la date active visible dans le bandeau défilant
  const active = conteneur.querySelector('.puce-date.actif');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function issueDe(h, a) {
  if (h > a) return 'home';
  return h < a ? 'away' : 'draw';
}

function carteMatch(m, cote, parisDuMatch) {
  const ouvert = m.status === 'scheduled' && !m.odds_locked
    && new Date(m.kickoff_at) > new Date();
  const termine = m.status === 'finished' && m.score_home !== null;
  const pari = parisDuMatch[0];

  // Cotes : celle de l'issue pronostiquée est mise en évidence
  const issuePari = pari ? issueDe(pari.predicted_home, pari.predicted_away) : null;
  const cotesMini = cote ? `
    <div class="cotes-mini">
      <span class="${issuePari === 'home' ? 'choisi' : ''}">${nombre(cote.home_odds, 2)}</span>
      ${cote.draw_odds ? `<span class="${issuePari === 'draw' ? 'choisi' : ''}">${nombre(cote.draw_odds, 2)}</span>` : ''}
      <span class="${issuePari === 'away' ? 'choisi' : ''}">${nombre(cote.away_odds, 2)}</span>
    </div>` : '';

  const centre = termine
    ? `<div class="cases-score">
         <div class="score-fige">${m.score_home}</div>
         <span class="deux-points">:</span>
         <div class="score-fige">${m.score_away}</div>
       </div>`
    : ouvert && cote
      ? `<div class="cases-score">
           <input class="case-score" data-camp="home" type="number" min="0" max="199"
                  inputmode="numeric" aria-label="Score ${echapper(m.home?.name)}">
           <span class="deux-points">:</span>
           <input class="case-score" data-camp="away" type="number" min="0" max="199"
                  inputmode="numeric" aria-label="Score ${echapper(m.away?.name)}">
         </div>`
      : `<div class="cases-score">
           <div class="score-fige">?</div>
           <span class="deux-points">:</span>
           <div class="score-fige">?</div>
         </div>`;

  return `
    <div class="carte carte-match" data-match="${m.id}">
      <div class="match-entete">
        <a class="competition" href="#/match/${m.id}">
          ${m.league?.sport === 'rugby' ? '🏉' : '⚽'}
          ${echapper(m.league?.name || '')}
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
      ${piedCarte(m, pari, parisDuMatch, termine)}
    </div>`;
}

function etiquetteStatut(m) {
  if (m.status === 'live') return '<span style="color:var(--rouge)">● en direct</span>';
  if (m.status === 'finished') return 'terminé';
  if (m.status === 'postponed') return 'reporté';
  if (m.status === 'cancelled') return 'annulé';
  return heure(m.kickoff_at);
}

function piedCarte(m, pari, parisDuMatch, termine) {
  if (!pari) {
    return parisDuMatch.length ? '' : `
      <div class="match-pied">
        <span class="retour-saisie faible"></span>
        <a class="lien-classement" href="#/match/${m.id}">Détails et mise →</a>
      </div>`;
  }
  const autres = parisDuMatch.length > 1
    ? ` <span class="faible">+${parisDuMatch.length - 1}</span>` : '';
  let pastille;
  if (pari.status === 'won') {
    const collecte = pari.collected_at;
    pastille = `<span class="gain-pastille ${collecte ? 'gagne' : 'collecte'}">
      ${collecte ? '' : '✦ '}+${eclats(gainPari(pari))} ✦</span>`;
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
        <div class="libelle">Mon pronostic${autres}</div>
        <div class="valeur">${pari.predicted_home} - ${pari.predicted_away}
          ${termine && pari.status === 'won'
            ? `<span class="faible">· ${echapper(libelleBonus(pari, m.score_home, m.score_away))}</span>`
            : ''}</div>
      </div>
      ${pastille}
    </div>`;
}

function brancherSaisie(conteneur, mise) {
  for (const carte of conteneur.querySelectorAll('.carte-match')) {
    const champs = carte.querySelectorAll('.case-score');
    if (champs.length !== 2) continue;
    const retour = carte.querySelector('.retour-saisie');
    let minuteur = null;

    const lire = () => [...champs].map((c) => c.value.trim());
    const dire = (texte, classe = 'faible') => {
      if (retour) { retour.textContent = texte; retour.className = `retour-saisie ${classe}`; }
    };

    const envoyer = async () => {
      clearTimeout(minuteur);
      const [ph, pa] = lire();
      if (ph === '' || pa === '') return;
      champs.forEach((c) => { c.disabled = true; });
      dire('Placement…');
      try {
        await placerPari(carte.dataset.match, Number(ph), Number(pa), mise);
        vibrer(18);
        toast(`Pari ${ph}-${pa} placé pour ${eclats(mise)} ✦`, 'succes');
        window.dispatchEvent(new Event('eclats-changes'));
        // Recharge la journée : la carte bascule en « pronostic placé »
        await rendre(conteneur);
      } catch (e) {
        dire(`Refusé : ${e.message}`, 'erreur');
        toast(e.message, 'echec');
        champs.forEach((c) => { c.disabled = false; });
      }
    };

    const planifier = () => {
      clearTimeout(minuteur);
      const [ph, pa] = lire();
      champs.forEach((c) => c.classList.toggle('rempli', c.value.trim() !== ''));
      if (ph === '' || pa === '') { dire(''); return; }
      dire(`Pari ${ph}-${pa} dans un instant…`);
      minuteur = setTimeout(envoyer, DELAI_ENVOI);
    };

    champs.forEach((c) => {
      c.addEventListener('input', planifier);
      c.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter') { evt.preventDefault(); c.blur(); envoyer(); }
      });
    });
  }
}
