// Page Paris : un jour à la fois (sélecteur de dates horizontal), cartes
// « blason · score · blason » façon MPP.
//   - match à venir : les cases sont modifiables à volonté, le pronostic
//     est enregistré en brouillon et validé au coup d'envoi
//   - match commencé ou joué : score figé, pronostic et gain rappelés

import {
  brouillonsSurMatchs, dernieresCotes, listeLigues, lireReglages,
  majMiseParDefaut, matchsDuJour, mesParisSurMatchs,
} from '../api.js';
import {
  classeCasesPronostic, classeGainPari, etatTemporelMatch, matchOuvert,
} from '../etat-prono.js';
import { embleme, nomLigue, trierLigues } from '../ordre-ligues.js';
import { brancherCases, casesScore } from '../saisie.js';
import {
  blason, cleJour, echapper, eclats, erreur, gainPari, heure, libelleBonus,
  nombre, squelettes, toast, vide,
} from '../ui.js';

const JOURS_AVANT = 3;
const JOURS_APRES = 9;

const etat = { date: null, sport: '', leagueId: '' };
let liguesCache = null;

function decalerJour(pas) {
  const [a, m, j] = etat.date.split('-').map(Number);
  const d = new Date(a, m - 1, j);
  d.setDate(d.getDate() + pas);
  const limiteBasse = new Date(); limiteBasse.setDate(limiteBasse.getDate() - JOURS_AVANT);
  const limiteHaute = new Date(); limiteHaute.setDate(limiteHaute.getDate() + JOURS_APRES);
  if (d < limiteBasse.setHours(0, 0, 0, 0) || d > limiteHaute.setHours(23, 59, 59, 0)) {
    return null;
  }
  return cleJour(d.toISOString());
}

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
  for (const l of trierLigues((liguesCache || []).filter(
    (l) => !etat.sport || l.sport === etat.sport))) {
    puces.push(`<button class="puce ${etat.leagueId === l.id ? 'actif' : ''}"
      data-ligue="${l.id}">${embleme(l)} ${echapper(l.name)}</button>`);
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
        m, cotes.get(m.id), paris.get(m.id) || [], brouillons.get(m.id), mise)).join('')
    : vide('📅', 'Aucun match ce jour',
        'Change de date ou de compétition avec les filtres ci-dessus.');

  conteneur.innerHTML = `
    ${bandeauDates()}
    ${bandeauFiltres()}
    ${bandeauMises(mise)}
    <div id="jour-courant">${liste}</div>`;
  brancherBandeaux(conteneur);
  brancherMises(conteneur);
  brancherSaisies(conteneur, mise);
  brancherGlissement(conteneur);
}

// Puces de mise par défaut : un raccourci pour changer rapidement le
// montant des paris rapides sans passer par les réglages.
const MISES = [10, 25, 50, 100, 250, 500, 1000];

function bandeauMises(mise) {
  return `<div class="mises-rapides">
    <span class="etiquette">Mise</span>
    ${MISES.map((v) => `<button class="puce-mise ${v === mise ? 'actif' : ''}"
      data-mise="${v}">${nombre(v)}</button>`).join('')}
  </div>`;
}

function brancherMises(conteneur) {
  conteneur.querySelectorAll('.puce-mise').forEach((b) => {
    b.addEventListener('click', async () => {
      const v = Number(b.dataset.mise);
      try {
        await majMiseParDefaut(v);
        rendre(conteneur);   // les pronos déjà enregistrés gardent leur mise
      } catch (e) {
        toast(e.message, 'echec');
      }
    });
  });
}

// Glissement horizontal pour changer de jour : la page suit le doigt,
// comme si les journées étaient posées côte à côte.
function brancherGlissement(conteneur) {
  const zone = conteneur.querySelector('#jour-courant');
  if (!zone) return;
  let departX = 0;
  let departY = 0;
  let horizontal = null;   // null tant que la direction n'est pas tranchée

  zone.addEventListener('touchstart', (evt) => {
    if (evt.touches.length !== 1) return;
    departX = evt.touches[0].clientX;
    departY = evt.touches[0].clientY;
    horizontal = null;
    zone.style.transition = 'none';
  }, { passive: true });

  zone.addEventListener('touchmove', (evt) => {
    if (evt.touches.length !== 1) return;
    const dx = evt.touches[0].clientX - departX;
    const dy = evt.touches[0].clientY - departY;
    if (horizontal === null) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      horizontal = Math.abs(dx) > Math.abs(dy) * 1.4;
    }
    if (!horizontal) return;
    // Résistance en bout de course quand il n'y a plus de jour
    const possible = decalerJour(dx < 0 ? 1 : -1) !== null;
    zone.style.transform = `translateX(${possible ? dx : dx * 0.25}px)`;
    zone.style.opacity = String(Math.max(0.4, 1 - Math.abs(dx) / 500));
  }, { passive: true });

  zone.addEventListener('touchend', (evt) => {
    if (!horizontal) { zone.style.transform = ''; zone.style.opacity = ''; return; }
    const dx = evt.changedTouches[0].clientX - departX;
    const seuil = Math.min(110, window.innerWidth * 0.25);
    const nouvelleDate = Math.abs(dx) > seuil ? decalerJour(dx < 0 ? 1 : -1) : null;
    zone.style.transition = 'transform .22s ease, opacity .22s ease';
    if (nouvelleDate) {
      // La page finit de sortir dans le sens du doigt, puis le jour change
      zone.style.transform = `translateX(${dx < 0 ? '-100%' : '100%'})`;
      zone.style.opacity = '0';
      setTimeout(() => { etat.date = nouvelleDate; rendre(conteneur); }, 180);
    } else {
      zone.style.transform = '';
      zone.style.opacity = '';
    }
  });
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

function carteMatch(m, cote, parisDuMatch, brouillon, mise) {
  const ouvert = matchOuvert(m);
  const termine = m.status === 'finished' && m.score_home !== null;
  const etatMatch = etatTemporelMatch(m);
  const enCours = etatMatch === 'en-cours' || etatMatch === 'verrouille';
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

  // Couleur des cases selon l'état, pour tout lire d'un coup d'œil :
  // vide, pronostic enregistré, pari verrouillé, puis gagné/perdu/annulé
  const etatCases = classeCasesPronostic(m, pari, brouillon);

  const centre = ouvert
    ? casesScore(m, brouillon, { mise })
    : `<div class="cases-score">
         <div class="score-fige ${etatCases}">${termine || enCours ? m.score_home ?? '?' : '?'}</div>
         <span class="deux-points">:</span>
         <div class="score-fige ${etatCases}">${termine || enCours ? m.score_away ?? '?' : '?'}</div>
       </div>`;

  // Mise engagée, sous le score : repère immédiatement les mises qui ne
  // sont pas au montant habituel
  const miseAffichee = pronostic
    ? `<div class="mise-mini ${pari ? 'ferme' : ''}">Mise ${eclats(
        pari ? pari.stake_eclats : pronostic.stake_eclats)} ✦</div>`
    : '';
  const libelleScore = ouvert ? 'Mon pronostic'
    : termine ? 'Score final' : 'Score du match';

  return `
    <div class="carte carte-match" data-match="${m.id}">
      <div class="match-entete">
        <a class="competition" href="#/match/${m.id}">
          ${embleme(m.league)} ${echapper(nomLigue(m.league))}
        </a>
        <span>${etiquetteStatut(m)}</span>
      </div>
      <div class="match-corps">
        <a class="equipe" href="#/equipe/${m.home_team_id}">
          ${blason(m.home)}<span class="nom">${echapper(m.home?.name)}</span>
        </a>
        <div class="bloc-score">
          <div class="score-libelle">${libelleScore}</div>
          ${centre}${cotesMini}${miseAffichee}
        </div>
        <a class="equipe" href="#/equipe/${m.away_team_id}">
          ${blason(m.away)}<span class="nom">${echapper(m.away?.name)}</span>
        </a>
      </div>
      ${piedCarte(m, pari, brouillon, parisDuMatch, termine, ouvert)}
    </div>`;
}

function etiquetteStatut(m) {
  const etatMatch = etatTemporelMatch(m);
  if (etatMatch === 'en-cours') return '<span style="color:var(--rouge)">● en direct</span>';
  if (etatMatch === 'verrouille') return '<span class="statut-verrouille">🔒 verrouillé</span>';
  if (etatMatch === 'termine') return 'terminé';
  if (etatMatch === 'reporte') return 'reporté';
  if (etatMatch === 'annule') return 'annulé';
  return heure(m.kickoff_at);
}

function piedCarte(m, pari, brouillon, parisDuMatch, termine, ouvert) {
  // Match à venir : état de l'enregistrement du brouillon
  if (ouvert) {
    return `
      <div class="match-pied">
        <span class="etat-saisie faible">${brouillon
          ? `Mon pronostic : ${brouillon.predicted_home} - ${brouillon.predicted_away} · enregistré`
          : 'Saisis ton pronostic'}</span>
        <a class="lien-classement" href="#/match/${m.id}">Détails et mise →</a>
      </div>`;
  }
  if (!pari) {
    return `
      <div class="match-pied">
        ${brouillon ? `<div>
          <div class="libelle">Mon pronostic</div>
          <div class="valeur">${brouillon.predicted_home} - ${brouillon.predicted_away}</div>
        </div>
        <span class="gain-pastille en-jeu">validation en attente</span>`
          : '<span class="faible">Aucun pronostic</span>'}
        <a class="lien-classement" href="#/match/${m.id}">Détails →</a>
      </div>`;
  }
  const autres = parisDuMatch.length > 1
    ? ` <span class="faible">+${parisDuMatch.length - 1}</span>` : '';
  let pastille;
  if (pari.status === 'won') {
    pastille = `<span class="gain-pastille ${classeGainPari(pari)}">
      +${eclats(gainPari(pari))} ✦${pari.collected_at ? '' : ' à récolter'}</span>`;
  } else if (pari.status === 'lost') {
    pastille = `<span class="gain-pastille ${classeGainPari(pari)}">
      −${eclats(pari.stake_eclats)} ✦</span>`;
  } else if (pari.status === 'void') {
    pastille = `<span class="gain-pastille ${classeGainPari(pari)}">
      annulé · ${eclats(pari.stake_eclats)} ✦ rendus</span>`;
  } else {
    pastille = `<span class="gain-pastille ${classeGainPari(pari)}">
      ${eclats(pari.stake_eclats)} ✦ en jeu</span>`;
  }
  return `
    <div class="match-pied">
      <div>
        <div class="libelle">Mon pronostic · pari validé${autres}</div>
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
      surChangement: (_home, _away, resultat) => {
        let miseMini = carte.querySelector('.mise-mini');
        if (resultat?.deleted) {
          if (miseMini) miseMini.remove();
          return;
        }
        const reservee = Number(resultat?.stake_eclats);
        if (!reservee) return;
        if (!miseMini) {
          miseMini = document.createElement('div');
          miseMini.className = 'mise-mini';
          carte.querySelector('.bloc-score')?.append(miseMini);
        }
        miseMini.textContent = `Mise ${eclats(reservee)} ✦`;
      },
    });
  }
}
