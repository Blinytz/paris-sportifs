// Page Statistiques : tout ce que les paris réglés permettent de mesurer.
// Les graphiques sont dessinés en SVG à la main (aucune bibliothèque, la
// PWA doit rester autonome hors ligne).

import { mesParis } from '../api.js';
import { embleme, nomLigue } from '../ordre-ligues.js';
import {
  bilan, courbeResultat, filtrerPeriode, parBonus, parCompetition, parEquipe,
  parIssue, parJour, parSport, qualitePronostic, series,
} from '../stats-calculs.js';
import { echapper, eclats, erreur, nombre, squelettes, vide } from '../ui.js';

const PERIODES = [
  { jours: 7, libelle: '7 jours' },
  { jours: 30, libelle: '30 jours' },
  { jours: 0, libelle: 'Tout' },
];
let periodeActive = 0;   // 0 = tout

export async function pageStats(conteneur) {
  conteneur.innerHTML = squelettes(4);
  try {
    rendre(conteneur, await mesParis());
  } catch (e) {
    conteneur.innerHTML = erreur(e);
  }
}

function rendre(conteneur, tousLesParis) {
  const paris = filtrerPeriode(tousLesParis, periodeActive);
  const b = bilan(paris);

  if (!b.regles && !b.enCours) {
    conteneur.innerHTML = `<h1>Statistiques</h1>${vide('📊',
      'Pas encore de pari réglé', 'Tes statistiques apparaîtront ici dès ton premier résultat.')}`;
    return;
  }

  const s = series(paris);
  const jours = parJour(paris);
  const bonus = parBonus(paris);
  const issues = parIssue(paris);
  const competitions = parCompetition(paris);
  const equipes = parEquipe(paris);
  const qualite = qualitePronostic(paris);
  const sports = parSport(paris);
  const courbe = courbeResultat(paris);

  const netJours = jours.map((j) => j.net);
  const moyenneJour = netJours.length
    ? netJours.reduce((x, y) => x + y, 0) / netJours.length : 0;
  const meilleurJour = jours.reduce((best, j) => (!best || j.net > best.net ? j : best), null);
  const pireJour = jours.reduce((pire, j) => (!pire || j.net < pire.net ? j : pire), null);

  conteneur.innerHTML = `
    <h1>Statistiques</h1>
    <div class="filtres">
      ${PERIODES.map((p) => `<button class="puce ${p.jours === periodeActive ? 'actif' : ''}"
        data-periode="${p.jours}">${p.libelle}</button>`).join('')}
    </div>

    ${blocResume(b, s)}
    ${blocFinancier(b)}
    ${jours.length > 1 ? blocGraphiques(jours, courbe, moyenneJour, meilleurJour, pireJour) : ''}
    ${blocReussite(b, issues, bonus, s)}
    ${qualite ? blocQualite(qualite) : ''}
    ${competitions.length ? blocCompetitions(competitions) : ''}
    ${equipes.length ? blocEquipes(equipes) : ''}
    ${Object.keys(sports).length > 1 ? blocSports(sports) : ''}`;

  conteneur.querySelectorAll('[data-periode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      periodeActive = Number(btn.dataset.periode);
      rendre(conteneur, tousLesParis, mouvements);
    });
  });
}

const signe = (v) => (v > 0 ? `+${eclats(v)}` : `${v < 0 ? '-' : ''}${eclats(Math.abs(v))}`);
const pourcent = (v) => (v === null || v === undefined ? '?' : `${Math.round(v * 100)} %`);

function tuile(valeur, libelle, classe = '') {
  return `<div class="tuile ${classe}">
    <span class="valeur">${valeur}</span><span class="libelle">${libelle}</span></div>`;
}

// ---------- Résumé ----------

function blocResume(b, s) {
  const classeNet = b.net > 0 ? 'positif' : b.net < 0 ? 'negatif' : '';
  return `
    <div class="carte centre bloc-resume">
      <div class="grand-nombre ${classeNet}">${signe(b.net)} ✦</div>
      <div class="faible">bénéfice net sur ${b.joues} pari${b.joues > 1 ? 's' : ''} joué${b.joues > 1 ? 's' : ''}</div>
      <div class="grille-tuiles" style="margin-top:.8rem">
        ${tuile(pourcent(b.tauxReussite), 'réussite')}
        ${tuile(b.retour === null ? '?' : `${Math.round(b.retour)} %`, 'retour sur mise')}
        ${tuile(s.enCoursTaille ? `${s.enCoursTaille}` : '0',
          s.enCoursType ? `d'affilée ${s.enCoursType}` : 'série')}
      </div>
    </div>`;
}

// ---------- Bilan financier ----------

function blocFinancier(b) {
  return `
    <h2>Bilan financier</h2>
    <div class="carte">
      <div class="grille-tuiles">
        ${tuile(`${eclats(b.miseJouee)} ✦`, 'total misé')}
        ${tuile(`${eclats(b.gains)} ✦`, 'total gagné')}
        ${tuile(`${signe(b.net)} ✦`, 'net', b.net > 0 ? 'positif' : b.net < 0 ? 'negatif' : '')}
        ${tuile(b.coteMoyenne ? nombre(b.coteMoyenne, 2) : '?', 'cote moyenne')}
        ${tuile(b.plusGrosGain ? `${eclats(gainDe(b.plusGrosGain))} ✦` : '?', 'plus gros gain')}
        ${tuile(b.plusGrossePerte ? `${eclats(b.plusGrossePerte.stake_eclats)} ✦` : '?', 'plus grosse perte')}
      </div>
      ${b.rembourses ? `<p class="faible centre">${b.rembourses} pari${b.rembourses > 1 ? 's' : ''}
        remboursé${b.rembourses > 1 ? 's' : ''} (match annulé), neutre${b.rembourses > 1 ? 's' : ''}
        dans les calculs.</p>` : ''}
      ${b.enCours ? `<p class="faible centre">${b.enCours} pari${b.enCours > 1 ? 's' : ''}
        encore en jeu.</p>` : ''}
    </div>`;
}

function gainDe(p) {
  return Math.ceil(Number(p.potential_payout) * (Number(p.bonus_multiplier) || 1));
}

// ---------- Graphiques ----------

function blocGraphiques(jours, courbe, moyenne, meilleur, pire) {
  return `
    <h2>Au fil du temps</h2>
    <div class="carte">
      <p class="faible">Résultat net par jour</p>
      ${barres(jours)}
      <div class="grille-tuiles" style="margin-top:.7rem">
        ${tuile(`${signe(moyenne)} ✦`, 'moyenne par jour',
          moyenne > 0 ? 'positif' : moyenne < 0 ? 'negatif' : '')}
        ${tuile(meilleur ? `${signe(meilleur.net)} ✦` : '?', 'meilleur jour', 'positif')}
        ${tuile(pire ? `${signe(pire.net)} ✦` : '?', 'pire jour', 'negatif')}
      </div>
    </div>
    ${courbe.length > 1 ? `<div class="carte">
      <p class="faible">Résultat cumulé sur les paris</p>${ligne(courbe)}</div>` : ''}`;
}

// Diagramme en barres : net par jour, au-dessus et en dessous de zéro
function barres(jours) {
  const derniers = jours.slice(-21);
  const max = Math.max(...derniers.map((j) => Math.abs(j.net)), 1);
  const largeur = 100 / derniers.length;
  return `
    <svg class="graphe" viewBox="0 0 100 60" preserveAspectRatio="none"
         role="img" aria-label="Résultat net par jour">
      <line x1="0" y1="30" x2="100" y2="30" stroke="var(--bordure)" stroke-width=".4"/>
      ${derniers.map((j, i) => {
        const h = (Math.abs(j.net) / max) * 26;
        const y = j.net >= 0 ? 30 - h : 30;
        const couleur = j.net >= 0 ? 'var(--vert)' : 'var(--rouge)';
        return `<rect x="${i * largeur + largeur * 0.15}" y="${y}"
          width="${largeur * 0.7}" height="${Math.max(h, 0.6)}"
          fill="${couleur}" rx=".6"><title>${j.jour} : ${signe(j.net)} Éclats</title></rect>`;
      }).join('')}
    </svg>
    <div class="axe-graphe">
      <span>${echapper(jourCourt(derniers[0].jour))}</span>
      <span>${echapper(jourCourt(derniers.at(-1).jour))}</span>
    </div>`;
}

// Courbe du résultat cumulé (peut passer sous zéro)
function ligne(courbe) {
  const points = courbe.slice(-120);
  const valeurs = points.map((p) => p.resultat);
  const min = Math.min(...valeurs, 0);
  const max = Math.max(...valeurs, 0);
  const etendue = max - min || 1;
  const yDe = (v) => 55 - ((v - min) / etendue) * 50;
  const chemin = points.map((p, i) => {
    const x = (i / Math.max(points.length - 1, 1)) * 100;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${yDe(p.resultat).toFixed(1)}`;
  }).join(' ');
  const yZero = yDe(0).toFixed(1);
  const dernier = valeurs.at(-1);
  const couleur = dernier >= 0 ? 'var(--vert)' : 'var(--rouge)';
  return `
    <svg class="graphe" viewBox="0 0 100 60" preserveAspectRatio="none"
         role="img" aria-label="Résultat cumulé sur les paris">
      <line x1="0" y1="${yZero}" x2="100" y2="${yZero}"
            stroke="var(--bordure)" stroke-width=".4"/>
      <path d="${chemin}" fill="none" stroke="${couleur}" stroke-width="1.4"
            stroke-linejoin="round" stroke-linecap="round"/>
    </svg>
    <div class="axe-graphe">
      <span>départ</span>
      <span>${signe(dernier)} ✦ à ce jour</span>
    </div>`;
}

function jourCourt(cle) {
  const [, m, j] = cle.split('-');
  return `${j}/${m}`;
}

// ---------- Réussite ----------

function blocReussite(b, issues, bonus, s) {
  const ligneIssue = (cle, libelle) => {
    const i = issues[cle];
    if (!i.joues) return '';
    return `<tr><td class="gauche">${libelle}</td><td>${i.gagnes}/${i.joues}</td>
      <td><strong>${pourcent(i.gagnes / i.joues)}</strong></td></tr>`;
  };
  return `
    <h2>Réussite</h2>
    <div class="carte">
      <div class="grille-tuiles">
        ${tuile(b.gagnes, 'gagnés', 'positif')}
        ${tuile(b.perdus, 'perdus', 'negatif')}
        ${tuile(bonus.compte.exact, 'scores exacts')}
        ${tuile(bonus.compte.ecart, 'bons écarts')}
        ${tuile(s.meilleure, 'meilleure série')}
        ${tuile(s.pire, 'pire série')}
      </div>
      <table class="classement" style="margin-top:.6rem">
        <thead><tr><th class="gauche">Issue pronostiquée</th><th>Gagnés</th><th>Taux</th></tr></thead>
        <tbody>
          ${ligneIssue('home', 'Victoire domicile')}
          ${ligneIssue('draw', 'Match nul')}
          ${ligneIssue('away', 'Victoire extérieur')}
        </tbody>
      </table>
      <p class="faible" style="margin-top:.6rem">D'où viennent les gains :
        bonne issue ${eclats(bonus.gains.issue)} ✦ ·
        bon écart ${eclats(bonus.gains.ecart)} ✦ ·
        score exact ${eclats(bonus.gains.exact)} ✦</p>
    </div>`;
}

// ---------- Qualité de pronostic ----------

function blocQualite(q) {
  const tendance = Math.abs(q.biaisMoyen) < 0.25 ? 'pronostics justes en volume'
    : q.biaisMoyen > 0 ? 'tu annonces trop de points' : 'tu annonces trop peu de points';
  const versusModele = q.tauxIssue - q.tauxAttendu;
  return `
    <h2>Qualité de mes pronostics</h2>
    <div class="carte">
      <div class="grille-tuiles">
        ${tuile(nombre(q.ecartMoyen, 1), 'écart moyen au score')}
        ${tuile(nombre(q.moyennePronostiquee, 1), 'points annoncés / match')}
        ${tuile(nombre(q.moyenneReelle, 1), 'points réels / match')}
        ${tuile(pourcent(q.tauxIssue), 'bonnes issues')}
        ${tuile(pourcent(q.tauxAttendu), 'attendu par les cotes')}
        ${tuile(`${versusModele >= 0 ? '+' : ''}${Math.round(versusModele * 100)} pts`,
          'écart au modèle', versusModele >= 0 ? 'positif' : 'negatif')}
      </div>
      <p class="faible centre">${echapper(tendance)}${versusModele >= 0
        ? ' · tu fais mieux que ce que les cotes prévoyaient'
        : ' · les cotes te devançaient sur cette période'}</p>
    </div>`;
}

// ---------- Par compétition ----------

function blocCompetitions(competitions) {
  return `
    <h2>Par compétition</h2>
    <div class="carte tableau-defilant">
      <table class="classement">
        <thead><tr><th class="gauche">Compétition</th><th>Paris</th>
          <th>Taux</th><th>Net</th></tr></thead>
        <tbody>
          ${competitions.map((c) => `
            <tr>
              <td class="gauche">${embleme(c.ligue)} ${echapper(nomLigue(c.ligue))}</td>
              <td>${c.paris}</td>
              <td>${pourcent(c.taux)}</td>
              <td class="${c.net > 0 ? 'gain-positif' : c.net < 0 ? 'gain-negatif' : ''}">
                ${signe(c.net)} ✦</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ---------- Par équipe ----------

function blocEquipes(equipes) {
  const rentables = equipes.filter((e) => e.net > 0).slice(0, 3);
  const couteuses = equipes.filter((e) => e.net < 0).slice(-3).reverse();
  const plusPariee = [...equipes].sort((a, b) => b.paris - a.paris)[0];
  const carteEquipe = (e, classe) => `
    <div class="ligne-equipe">
      <a href="#/equipe/${e.equipe.id}">${echapper(e.equipe.name)}</a>
      <span class="faible">${e.paris} pari${e.paris > 1 ? 's' : ''}</span>
      <span class="${classe}">${signe(e.net)} ✦</span>
    </div>`;
  return `
    <h2>Par équipe</h2>
    <div class="carte">
      ${plusPariee ? `<p class="faible">La plus suivie :
        <strong>${echapper(plusPariee.equipe.name)}</strong>
        (${plusPariee.paris} paris)</p>` : ''}
      ${rentables.length ? `<p class="faible" style="margin-top:.6rem">Les plus rentables</p>
        ${rentables.map((e) => carteEquipe(e, 'gain-positif')).join('')}` : ''}
      ${couteuses.length ? `<p class="faible" style="margin-top:.6rem">Les plus coûteuses</p>
        ${couteuses.map((e) => carteEquipe(e, 'gain-negatif')).join('')}` : ''}
    </div>`;
}

// ---------- Foot contre rugby ----------

function blocSports(sports) {
  const colonne = (cle, titre, emoji) => {
    const b = sports[cle];
    if (!b) return '';
    return `
      <div>
        <h3>${emoji} ${titre}</h3>
        <p><strong>${b.joues}</strong> paris · ${pourcent(b.tauxReussite)}</p>
        <p class="${b.net > 0 ? 'gain-positif' : b.net < 0 ? 'gain-negatif' : ''}">
          ${signe(b.net)} ✦</p>
        <p class="faible">cote moyenne ${b.coteMoyenne ? nombre(b.coteMoyenne, 2) : '?'}</p>
      </div>`;
  };
  return `
    <h2>Football contre rugby</h2>
    <div class="carte comparatif">
      ${colonne('football', 'Football', '⚽')}
      ${colonne('rugby', 'Rugby', '🏉')}
    </div>`;
}
