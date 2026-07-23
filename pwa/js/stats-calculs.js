// Tous les calculs statistiques, séparés de l'affichage pour rester
// testables. Un « pari réglé » est un pari gagné, perdu ou remboursé ;
// les paris remboursés (match annulé) sont neutres et sortent des taux
// de réussite.

import { cleJour, gainPari } from './ui.js';

const REGLES = new Set(['won', 'lost', 'void']);

export function estRegle(p) { return REGLES.has(p.status); }
export function estJoue(p) { return p.status === 'won' || p.status === 'lost'; }

// Résultat réel d'un match terminé, du point de vue du pronostic
function issue(h, a) {
  if (h > a) return 'home';
  return h < a ? 'away' : 'draw';
}

export function sportDe(p) {
  return p.match?.league?.sport === 'rugby' ? 'rugby' : 'football';
}

// Niveau de réussite d'un pari gagné, d'après son multiplicateur
export function niveauBonus(p) {
  const m = Number(p.bonus_multiplier) || 1;
  if (m >= 2) return 'exact';
  if (m > 1) return 'ecart';
  return 'issue';
}

export function bilan(paris) {
  const joues = paris.filter(estJoue);
  const gagnes = paris.filter((p) => p.status === 'won');
  const perdus = paris.filter((p) => p.status === 'lost');
  const rembourses = paris.filter((p) => p.status === 'void');
  const enCours = paris.filter((p) => p.status === 'pending');

  const mise = paris.filter(estRegle).reduce((s, p) => s + Number(p.stake_eclats), 0);
  const miseJouee = joues.reduce((s, p) => s + Number(p.stake_eclats), 0);
  const gains = gagnes.reduce((s, p) => s + gainPari(p), 0);
  const net = gains - miseJouee;

  return {
    total: paris.length,
    regles: paris.filter(estRegle).length,
    joues: joues.length,
    gagnes: gagnes.length,
    perdus: perdus.length,
    rembourses: rembourses.length,
    enCours: enCours.length,
    tauxReussite: joues.length ? gagnes.length / joues.length : null,
    mise, miseJouee, gains, net,
    // Retour sur mise : ce que rapportent 100 Éclats engagés
    retour: miseJouee ? (gains / miseJouee) * 100 : null,
    coteMoyenne: joues.length
      ? joues.reduce((s, p) => s + Number(p.odds_at_bet), 0) / joues.length : null,
    plusGrosGain: gagnes.reduce(
      (best, p) => (!best || gainPari(p) > gainPari(best) ? p : best), null),
    plusGrossePerte: perdus.reduce(
      (pire, p) => (!pire || Number(p.stake_eclats) > Number(pire.stake_eclats) ? p : pire), null),
    aRecolter: paris.filter((p) => !p.collected_at && (p.status === 'won' || p.status === 'void')).length,
  };
}

// Répartition des paris gagnés par niveau de bonus décroché
export function parBonus(paris) {
  const compte = { issue: 0, ecart: 0, exact: 0 };
  const gains = { issue: 0, ecart: 0, exact: 0 };
  for (const p of paris.filter((x) => x.status === 'won')) {
    const n = niveauBonus(p);
    compte[n] += 1;
    gains[n] += gainPari(p);
  }
  return { compte, gains };
}

// Réussite selon l'issue pronostiquée (domicile, nul, extérieur)
export function parIssue(paris) {
  const res = {
    home: { joues: 0, gagnes: 0 },
    draw: { joues: 0, gagnes: 0 },
    away: { joues: 0, gagnes: 0 },
  };
  for (const p of paris.filter(estJoue)) {
    const cle = p.selection;
    if (!res[cle]) continue;
    res[cle].joues += 1;
    if (p.status === 'won') res[cle].gagnes += 1;
  }
  return res;
}

// Séries de paris gagnés (en cours et record), du plus ancien au plus récent
export function series(paris) {
  const joues = paris.filter(estJoue)
    .sort((a, b) => new Date(a.resolved_at) - new Date(b.resolved_at));
  let courante = 0;
  let meilleure = 0;
  let pireCourante = 0;
  let pire = 0;
  for (const p of joues) {
    if (p.status === 'won') {
      courante += 1; pireCourante = 0;
      meilleure = Math.max(meilleure, courante);
    } else {
      pireCourante += 1; courante = 0;
      pire = Math.max(pire, pireCourante);
    }
  }
  const dernier = joues.at(-1);
  return {
    enCours: courante,
    enCoursType: dernier ? (dernier.status === 'won' ? 'gagnés' : 'perdus') : null,
    enCoursTaille: dernier ? (dernier.status === 'won' ? courante : pireCourante) : 0,
    meilleure, pire,
  };
}

// Agrégat par jour (clé locale AAAA-MM-JJ) sur la date de règlement
export function parJour(paris) {
  const jours = new Map();
  for (const p of paris.filter(estJoue)) {
    const cle = cleJour(p.resolved_at || p.placed_at);
    if (!jours.has(cle)) jours.set(cle, { jour: cle, mise: 0, gains: 0, paris: 0, gagnes: 0 });
    const j = jours.get(cle);
    j.paris += 1;
    j.mise += Number(p.stake_eclats);
    if (p.status === 'won') { j.gains += gainPari(p); j.gagnes += 1; }
  }
  return [...jours.values()]
    .map((j) => ({ ...j, net: j.gains - j.mise }))
    .sort((a, b) => a.jour.localeCompare(b.jour));
}

// Agrégat par compétition
export function parCompetition(paris) {
  const ligues = new Map();
  for (const p of paris.filter(estJoue)) {
    const l = p.match?.league;
    if (!l) continue;
    if (!ligues.has(l.id)) {
      ligues.set(l.id, { ligue: l, paris: 0, gagnes: 0, mise: 0, gains: 0 });
    }
    const c = ligues.get(l.id);
    c.paris += 1;
    c.mise += Number(p.stake_eclats);
    if (p.status === 'won') { c.gagnes += 1; c.gains += gainPari(p); }
  }
  return [...ligues.values()]
    .map((c) => ({ ...c, net: c.gains - c.mise, taux: c.gagnes / c.paris }))
    .sort((a, b) => b.net - a.net);
}

// Agrégat par équipe : une équipe compte dès qu'elle joue le match parié
export function parEquipe(paris) {
  const equipes = new Map();
  const ajouter = (equipe, p) => {
    if (!equipe?.id) return;
    if (!equipes.has(equipe.id)) {
      equipes.set(equipe.id, { equipe, paris: 0, gagnes: 0, mise: 0, gains: 0 });
    }
    const e = equipes.get(equipe.id);
    e.paris += 1;
    e.mise += Number(p.stake_eclats);
    if (p.status === 'won') { e.gagnes += 1; e.gains += gainPari(p); }
  };
  for (const p of paris.filter(estJoue)) {
    ajouter(p.match?.home, p);
    ajouter(p.match?.away, p);
  }
  return [...equipes.values()]
    .map((e) => ({ ...e, net: e.gains - e.mise }))
    .sort((a, b) => b.net - a.net);
}

// Qualité du pronostic : écart entre score annoncé et score réel
export function qualitePronostic(paris) {
  const joues = paris.filter((p) => estJoue(p)
    && p.match?.score_home !== null && p.match?.score_home !== undefined);
  if (!joues.length) return null;
  let ecartTotal = 0;
  let biais = 0;              // > 0 : tendance à annoncer trop de buts
  let butsPronostiques = 0;
  let butsReels = 0;
  let issuesTrouvees = 0;
  let probaCumulee = 0;       // somme des probabilités implicites jouées
  for (const p of joues) {
    const sh = p.match.score_home;
    const sa = p.match.score_away;
    ecartTotal += Math.abs(p.predicted_home - sh) + Math.abs(p.predicted_away - sa);
    biais += (p.predicted_home + p.predicted_away) - (sh + sa);
    butsPronostiques += p.predicted_home + p.predicted_away;
    butsReels += sh + sa;
    if (issue(p.predicted_home, p.predicted_away) === issue(sh, sa)) issuesTrouvees += 1;
    probaCumulee += 1 / Number(p.odds_at_bet);
  }
  const n = joues.length;
  return {
    matchs: n,
    ecartMoyen: ecartTotal / n,
    biaisMoyen: biais / n,
    moyennePronostiquee: butsPronostiques / n,
    moyenneReelle: butsReels / n,
    tauxIssue: issuesTrouvees / n,
    // Le modèle prévoyait ce taux de réussite : au-dessus, on le bat
    tauxAttendu: probaCumulee / n,
  };
}

// Comparaison des deux sports
export function parSport(paris) {
  const res = {};
  for (const sport of ['football', 'rugby']) {
    const sous = paris.filter((p) => sportDe(p) === sport);
    if (sous.filter(estJoue).length) res[sport] = bilan(sous);
  }
  return res;
}

// Courbe du solde dans le temps, à partir des mouvements du portefeuille
export function courbeSolde(mouvements) {
  let cumul = 0;
  return mouvements.map((m) => {
    cumul += Number(m.amount);
    return { date: m.created_at, solde: cumul };
  });
}

// Filtre une liste de paris sur une période (en jours, 0 = tout)
export function filtrerPeriode(paris, jours) {
  if (!jours) return paris;
  const limite = Date.now() - jours * 86400000;
  return paris.filter((p) => new Date(p.resolved_at || p.placed_at).getTime() >= limite);
}
