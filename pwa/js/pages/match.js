// Page match : en-tête avec blasons, formulaire de pari à mise libre,
// puis deux onglets « Avant-match » (comparatif + confrontations) et
// « Classement ». Un pari gagné se récolte aussi depuis ici.

import {
  classementLigue, collecter, confrontations, dernieresCotes,
  enregistrerBrouillon, lireBrouillon, lireMatch, lireReglages, matchsEquipe,
  mesParisSurMatch, positionsDansLigue, statsCompetition, statsGlobales,
} from '../api.js';
import { embleme, nomLigue } from '../ordre-ligues.js';
import { brancherCases, casesScore } from '../saisie.js';
import {
  badgesForme, blason, dateHeure, echapper, eclats, envoyerPieces, erreur,
  formeDepuisMatchs, gainPari, libelleBonus, nombre, ordinal, probaImplicite,
  squelettes, toast,
} from '../ui.js';

const ISSUES = { home: 'domicile', draw: 'nul', away: 'extérieur' };
const STATUTS = {
  live: '● en direct', postponed: 'reporté', cancelled: 'annulé',
  finished: 'terminé',
};

let ongletActif = 'avant';

export async function pageMatch(conteneur, matchId) {
  conteneur.innerHTML = squelettes(3);
  try {
    const match = await lireMatch(matchId);
    if (!match) {
      conteneur.innerHTML = '<div class="vide"><span class="emoji">🔍</span>'
        + '<p>Match introuvable.</p></div>';
      return;
    }
    const [cotesMap, paris, reglages, brouillon] = await Promise.all([
      dernieresCotes([match.id],
        match.status === 'finished' ? match.kickoff_at : null),
      mesParisSurMatch(match.id),
      lireReglages(),
      lireBrouillon(match.id),
    ]);
    rendre(conteneur, match, cotesMap.get(match.id), paris, reglages, brouillon);
  } catch (e) {
    conteneur.innerHTML = erreur(e);
  }
}

function rendre(conteneur, match, cotes, paris, reglages, brouillon) {
  const termine = match.status === 'finished' && match.score_home !== null;
  const enCours = match.status === 'live';
  const ouvert = match.status === 'scheduled'
    && new Date(match.kickoff_at) > new Date();
  const estChampionnat = match.league?.category === 'championnat';

  conteneur.innerHTML = `
    <div class="carte">
      <div class="match-entete">
        <span class="competition">${embleme(match.league)}
          ${echapper(nomLigue(match.league))}</span>
        <span>${echapper(STATUTS[match.status] || dateHeure(match.kickoff_at))}</span>
      </div>
      <div class="match-corps">
        <a class="equipe" href="#/equipe/${match.home_team_id}">
          ${blason(match.home)}<span class="nom">${echapper(match.home?.name)}</span>
        </a>
        <div class="bloc-score">
          <div class="cases-score">
            <div class="score-fige">${termine || enCours ? match.score_home ?? '?' : '?'}</div>
            <span class="deux-points">:</span>
            <div class="score-fige">${termine || enCours ? match.score_away ?? '?' : '?'}</div>
          </div>
          ${cotes ? `<div class="cotes-mini">
            <span>${nombre(cotes.home_odds, 2)}</span>
            ${cotes.draw_odds ? `<span>${nombre(cotes.draw_odds, 2)}</span>` : ''}
            <span>${nombre(cotes.away_odds, 2)}</span></div>` : ''}
        </div>
        <a class="equipe" href="#/equipe/${match.away_team_id}">
          ${blason(match.away)}<span class="nom">${echapper(match.away?.name)}</span>
        </a>
      </div>
      <div class="faible centre" style="margin-top:.6rem">
        ${echapper(dateHeure(match.kickoff_at))}</div>
    </div>

    ${paris.length ? blocMesParis(match, paris) : ''}

    ${ouvert ? blocPronostic(match, cotes, reglages, brouillon) : ''}

    <div class="onglets-internes">
      <button data-onglet="avant" class="${ongletActif === 'avant' ? 'actif' : ''}">
        Avant-match</button>
      <button data-onglet="classement" class="${ongletActif === 'classement' ? 'actif' : ''}"
        ${estChampionnat ? '' : 'disabled'}>Classement</button>
    </div>
    <div id="contenu-onglet">${squelettes(2)}</div>`;

  conteneur.querySelectorAll('.onglets-internes button').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.disabled) return;
      ongletActif = b.dataset.onglet;
      conteneur.querySelectorAll('.onglets-internes button').forEach(
        (x) => x.classList.toggle('actif', x === b));
      chargerOnglet(conteneur, match, cotes, reglages);
    });
  });

  if (ouvert) brancherPronostic(conteneur, match, cotes, reglages, brouillon);
  brancherRecolte(conteneur);
  chargerOnglet(conteneur, match, cotes, reglages);
}

// ---------- Mes paris sur ce match ----------

function blocMesParis(match, paris) {
  return `
    <div class="carte">
      <h2 style="margin-top:0">Mes pronostics</h2>
      ${paris.map((p) => {
        const recoltable = (p.status === 'won' || p.status === 'void') && !p.collected_at;
        const montant = p.status === 'won' ? gainPari(p) : Number(p.stake_eclats);
        return `
        <div class="match-pied" data-pari="${p.id}" style="border-top:0;padding-top:0">
          <div>
            <div class="libelle">${eclats(p.stake_eclats)} ✦ à
              ${echapper(Number(p.odds_at_bet).toFixed(2))}</div>
            <div class="valeur">${p.predicted_home} - ${p.predicted_away}
              ${p.status === 'won'
                ? `<span class="faible">· ${echapper(libelleBonus(p, match.score_home, match.score_away))}</span>` : ''}</div>
          </div>
          ${recoltable
            ? `<button class="btn-or bouton-recolter" data-pari="${p.id}"
                 data-montant="${montant}">Récolter ${eclats(montant)} ✦</button>`
            : p.status === 'won'
              ? `<span class="gain-pastille gagne">+${eclats(gainPari(p))} ✦</span>`
              : p.status === 'lost'
                ? '<span class="gain-pastille perdu">perdu</span>'
                : p.status === 'void'
                  ? '<span class="gain-pastille attente">remboursé</span>'
                  : '<span class="gain-pastille attente">en cours</span>'}
        </div>`;
      }).join('')}
    </div>`;
}

function brancherRecolte(conteneur) {
  conteneur.querySelectorAll('.bouton-recolter').forEach((bouton) => {
    bouton.addEventListener('click', async () => {
      const ligne = bouton.closest('[data-pari]');
      bouton.disabled = true;
      bouton.textContent = '…';
      try {
        await collecter([bouton.dataset.pari]);
        envoyerPieces(ligne, 6);
        window.dispatchEvent(new Event('eclats-collectes'));
        toast(`+${eclats(bouton.dataset.montant)} ✦ récoltés`, 'succes');
        bouton.replaceWith(Object.assign(document.createElement('span'), {
          className: 'gain-pastille gagne',
          textContent: `+${eclats(bouton.dataset.montant)} ✦`,
        }));
      } catch (e) {
        bouton.disabled = false;
        bouton.textContent = 'Récolter';
        toast(e.message, 'echec');
      }
    });
  });
}

// ---------- Formulaire de pari (mise libre) ----------

function blocPronostic(match, cotes, reglages, brouillon) {
  const mise = Number(brouillon?.stake_eclats)
    || Number(reglages?.default_stake) || 100;
  const debut = new Date(match.kickoff_at).toLocaleString('fr-FR',
    { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  return `
    <div class="carte">
      <h2 style="margin-top:0">Mon pronostic</h2>
      <div class="match-corps">
        <span class="faible centre">${echapper(match.home?.name)}</span>
        ${casesScore(match, brouillon)}
        <span class="faible centre">${echapper(match.away?.name)}</span>
      </div>
      <div class="rangee-mise" style="margin-top:.8rem">
        <label>Mise en Éclats
          <input type="number" id="pari-mise" min="1" step="10" value="${mise}"></label>
      </div>
      <div class="apercu-gains" id="apercu-gains" ${brouillon ? '' : 'hidden'}>
        <div>Bonne issue<strong id="gain-base">?</strong></div>
        <div id="case-ecart">Bon écart<strong id="gain-ecart">?</strong></div>
        <div>Score exact<strong id="gain-exact">?</strong></div>
      </div>
      <p class="faible" id="retour-pari"></p>
      <p class="faible">🔒 Modifiable jusqu'au coup d'envoi
        (${echapper(debut)}), où la mise sera débitée et le pari validé.</p>
    </div>`;
}

function brancherPronostic(conteneur, match, cotes, reglages, brouillon) {
  const miseChamp = conteneur.querySelector('#pari-mise');
  const retour = conteneur.querySelector('#retour-pari');
  const apercu = conteneur.querySelector('#apercu-gains');
  const estRugby = match.league?.sport === 'rugby';
  const bonusEcart = estRugby
    ? (Number(reglages?.bonus_ecart_rugby) || 1.5)
    : (Number(reglages?.bonus_ecart) || 1.5);
  const bonusNul = Number(reglages?.bonus_ecart_nul) || 1.25;
  const bonusExact = estRugby
    ? (Number(reglages?.bonus_score_exact_rugby) || 10)
    : (Number(reglages?.bonus_score_exact) || 2);
  const champs = [...conteneur.querySelectorAll('.cases-score .case-score')];

  const majApercu = () => {
    const [ph, pa] = champs.map((c) => c.value.trim());
    if (ph === '' || pa === '' || !cotes) { apercu.hidden = true; return; }
    const issue = Number(ph) > Number(pa) ? 'home'
      : Number(ph) < Number(pa) ? 'away' : 'draw';
    const cote = issue === 'home' ? cotes.home_odds
      : issue === 'away' ? cotes.away_odds : cotes.draw_odds;
    if (cote == null) {
      apercu.hidden = true;
      retour.textContent = 'Cote indisponible pour cette issue.';
      return;
    }
    const base = (Number(miseChamp.value) || 0) * Number(cote);
    const facteurEcart = (!estRugby && issue === 'draw') ? bonusNul : bonusEcart;
    apercu.hidden = false;
    conteneur.querySelector('#gain-base').textContent = `${eclats(base)} ✦`;
    conteneur.querySelector('#gain-ecart').textContent = `${eclats(base * facteurEcart)} ✦`;
    conteneur.querySelector('#gain-exact').textContent = `${eclats(base * bonusExact)} ✦`;
    conteneur.querySelector('#case-ecart').firstChild.textContent =
      estRugby ? 'Bonne tranche d\'écart ' : 'Bon écart ';
    retour.textContent = `Issue : ${ISSUES[issue]} · cote ${nombre(cote, 2)}`;
  };

  // Les cases enregistrent le brouillon ; la mise saisie ici l'accompagne
  brancherCases(conteneur, {
    mise: Number(miseChamp.value) || 100,
    surEtat: (texte, classe) => {
      if (classe === 'ok') toast('Pronostic enregistré', 'succes');
      retour.textContent = texte;
    },
    surChangement: majApercu,
  });
  champs.forEach((c) => c.addEventListener('input', majApercu));

  // Changer la mise réenregistre le brouillon existant
  let minuteurMise = null;
  miseChamp.addEventListener('input', () => {
    majApercu();
    clearTimeout(minuteurMise);
    minuteurMise = setTimeout(async () => {
      const [ph, pa] = champs.map((c) => c.value.trim());
      if (ph === '' || pa === '') return;
      try {
        await enregistrerBrouillon(match.id, Number(ph), Number(pa),
          Number(miseChamp.value) || 100);
        retour.textContent = 'Mise enregistrée ✓';
      } catch (e) {
        toast(e.message, 'echec');
      }
    }, 700);
  });

  if (brouillon) majApercu();
}

// ---------- Onglets ----------

async function chargerOnglet(conteneur, match, cotes, reglages) {
  const zone = conteneur.querySelector('#contenu-onglet');
  if (!zone) return;
  zone.innerHTML = squelettes(2);
  try {
    zone.innerHTML = ongletActif === 'classement'
      ? await vueClassement(match)
      : await vueAvantMatch(match, cotes, reglages);
    const bouton = zone.querySelector('#h2h-plus-bouton');
    if (bouton) {
      bouton.addEventListener('click', () => {
        zone.querySelector('#h2h-plus').hidden = false;
        bouton.remove();
      });
    }
  } catch (e) {
    zone.innerHTML = erreur(e);
  }
}

async function vueClassement(match) {
  const lignes = await classementLigue(match.league_id);
  if (!lignes.length) {
    return '<p class="muet centre">Classement pas encore synchronisé '
      + 'pour cette compétition.</p>';
  }
  const surligne = new Set([match.home_team_id, match.away_team_id]);
  return `
    <div class="carte tableau-defilant">
      <table class="classement">
        <thead><tr><th></th><th class="gauche">Équipe</th><th>Pts</th>
          <th>J</th><th>V</th><th>N</th><th>D</th><th>±</th></tr></thead>
        <tbody>
          ${lignes.map((l) => `
            <tr style="${surligne.has(l.team_id) ? 'background:var(--or-clair)' : ''}">
              <td class="position">${echapper(l.position)}</td>
              <td class="gauche"><a href="#/equipe/${l.team_id}">${echapper(l.team?.name)}</a></td>
              <td><strong>${nombre(l.points)}</strong></td>
              <td>${nombre(l.games_played)}</td>
              <td>${nombre(l.wins)}</td>
              <td>${nombre(l.draws)}</td>
              <td>${nombre(l.losses)}</td>
              <td>${(l.score_for ?? 0) - (l.score_against ?? 0) > 0 ? '+' : ''}${nombre((l.score_for ?? 0) - (l.score_against ?? 0))}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

const moyenne = (somme, total) => (total ? nombre(somme / total, 1) : '?');

async function vueAvantMatch(match, cotes, reglages) {
  const avant = match.status === 'finished' ? match.kickoff_at : null;
  const fenetre = reglages?.form_window_size || 5;
  const positions = match.league?.category === 'championnat'
    ? await positionsDansLigue(match.league_id,
        [match.home_team_id, match.away_team_id])
    : new Map();

  const equipes = [
    { id: match.home_team_id, nom: match.home?.name, rating: match.home?.rating,
      camp: 'home', libelle: 'domicile', cote: cotes?.home_odds },
    { id: match.away_team_id, nom: match.away?.name, rating: match.away?.rating,
      camp: 'away', libelle: 'extérieur', cote: cotes?.away_odds },
  ];

  const colonnes = await Promise.all(equipes.map(async (e) => {
    const tous = await matchsEquipe(e.id, { statut: 'finished', avant, limite: 50 });
    const dansCompet = tous.filter((m) => m.league_id === match.league_id);
    const duCamp = tous.filter((m) => (e.camp === 'home'
      ? m.home_team_id === e.id : m.away_team_id === e.id));

    let global = { mp: 0, sf: 0, sc: 0 };
    let compet = { mp: 0, sf: 0, sc: 0 };
    if (avant) {
      global = cumul(tous, e.id);
      compet = cumul(dansCompet, e.id);
    } else {
      const [g, c] = await Promise.all([
        statsGlobales(e.id), statsCompetition(e.id, match.league_id)]);
      if (g) global = { mp: g.matches_played, sf: g.score_for, sc: g.score_against };
      if (c) compet = { mp: c.matches_played, sf: c.score_for, sc: c.score_against };
    }
    const rang = positions.get(e.id);
    return `
      <div class="colonne-equipe">
        <h3>${echapper(e.nom)}</h3>
        ${rang ? `<p><a class="lien-classement" href="#/classement/${match.league_id}">
          ${echapper(ordinal(rang.position))} · ${nombre(rang.points)} pts</a></p>` : ''}
        <p>Elo <strong>${nombre(e.rating, 1)}</strong>
          <span class="faible">· ${probaImplicite(e.cote)}</span></p>
        <p class="faible">Forme</p><p>${badgesForme(formeDepuisMatchs(tous, e.id, fenetre))}</p>
        <p class="faible">Dans la compétition</p><p>${badgesForme(formeDepuisMatchs(dansCompet, e.id, fenetre))}</p>
        <p class="faible">À ${e.libelle}</p><p>${badgesForme(formeDepuisMatchs(duCamp, e.id, fenetre))}</p>
        <p class="faible">Moyennes pour / contre<br>
          global ${moyenne(global.sf, global.mp)} / ${moyenne(global.sc, global.mp)}<br>
          compét. ${moyenne(compet.sf, compet.mp)} / ${moyenne(compet.sc, compet.mp)}</p>
      </div>`;
  }));

  const rencontres = (await confrontations(match.home_team_id, match.away_team_id))
    .filter((x) => x.id !== match.id);

  return `
    ${avant ? '<p class="faible centre">⏱ Situation telle qu\'elle était avant le match.</p>' : ''}
    <div class="carte comparatif">${colonnes.join('')}</div>
    <h2>Confrontations directes</h2>
    ${rencontres.length ? blocH2H(rencontres)
      : '<p class="muet centre">Aucune confrontation enregistrée.</p>'}`;
}

function cumul(matchs, teamId) {
  const s = { mp: 0, sf: 0, sc: 0 };
  for (const m of matchs) {
    if (m.score_home === null || m.score_away === null) continue;
    const estDom = m.home_team_id === teamId;
    s.mp += 1;
    s.sf += estDom ? m.score_home : m.score_away;
    s.sc += estDom ? m.score_away : m.score_home;
  }
  return s;
}

function blocH2H(liste) {
  const ligne = (m) => `
    <a class="carte" href="#/match/${m.id}">
      <div class="match-entete">
        <span class="competition">${echapper(m.league?.name)}</span>
        <span>${dateHeure(m.kickoff_at)}</span>
      </div>
      <div class="match-corps">
        <span class="faible centre">${echapper(m.home?.name)}</span>
        <div class="cases-score">
          <div class="score-fige">${m.score_home ?? '?'}</div>
          <span class="deux-points">:</span>
          <div class="score-fige">${m.score_away ?? '?'}</div>
        </div>
        <span class="faible centre">${echapper(m.away?.name)}</span>
      </div>
    </a>`;
  const visibles = liste.slice(0, 5).map(ligne).join('');
  const masques = liste.slice(5).map(ligne).join('');
  return `${visibles}
    ${masques ? `<div id="h2h-plus" hidden>${masques}</div>
      <button class="btn-fantome" id="h2h-plus-bouton" style="width:100%">
        Voir les ${liste.length - 5} autres</button>` : ''}`;
}
