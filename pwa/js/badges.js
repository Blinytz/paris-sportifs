// Badges d'accomplissement, purement cosmétiques. Ils sont recalculés à
// la volée depuis l'historique de paris : rien n'est stocké, l'état
// « débloqué » se déduit toujours des données.

import { estJoue, niveauBonus } from './stats-calculs.js';
import { gainPari } from './ui.js';

// Identifiants des 5 grands championnats (external_id Highlightly)
const GRANDS_CHAMPIONNATS = new Set([52695, 33973, 119924, 67162, 115669]);

function sportDe(p) {
  return p.match?.league?.sport === 'rugby' ? 'rugby' : 'football';
}

// Plus longue série de paris gagnés (paris triés par date de règlement)
function meilleureSerie(paris) {
  const joues = paris.filter(estJoue)
    .sort((a, b) => new Date(a.resolved_at) - new Date(b.resolved_at));
  let max = 0;
  let cur = 0;
  for (const p of joues) {
    cur = p.status === 'won' ? cur + 1 : 0;
    max = Math.max(max, cur);
  }
  return max;
}

// Chaque badge : un test sur la liste des paris (tous statuts). Les tests
// ne considèrent que ce qui est certain (paris gagnés pour les exploits).
export const BADGES = [
  { id: 'premier-pari', emoji: '🎫', nom: 'Premier pari',
    aide: 'Placer ton tout premier pari',
    test: (p) => p.length > 0 },
  { id: 'premier-gain', emoji: '✅', nom: 'Premier gain',
    aide: 'Gagner un pari',
    test: (p) => p.some((x) => x.status === 'won') },
  { id: 'score-exact', emoji: '🎯', nom: 'Dans le mille',
    aide: 'Trouver un score exact',
    test: (p) => p.some((x) => x.status === 'won' && niveauBonus(x) === 'exact') },
  { id: 'exact-rugby', emoji: '🏉', nom: 'Devin du rugby',
    aide: 'Trouver un score exact au rugby (rarissime)',
    test: (p) => p.some((x) => x.status === 'won' && niveauBonus(x) === 'exact'
      && sportDe(x) === 'rugby') },
  { id: 'serie-5', emoji: '🔥', nom: 'En feu',
    aide: '5 paris gagnés d’affilée',
    test: (p) => meilleureSerie(p) >= 5 },
  { id: 'serie-10', emoji: '🌋', nom: 'Série légendaire',
    aide: '10 paris gagnés d’affilée',
    test: (p) => meilleureSerie(p) >= 10 },
  { id: 'cote-5', emoji: '💰', nom: 'Gros coup',
    aide: 'Gagner un pari à cote 5 ou plus',
    test: (p) => p.some((x) => x.status === 'won' && Number(x.odds_at_bet) >= 5) },
  { id: 'cote-10', emoji: '🦄', nom: 'Outsider',
    aide: 'Gagner un pari à cote 10 ou plus',
    test: (p) => p.some((x) => x.status === 'won' && Number(x.odds_at_bet) >= 10) },
  { id: 'polyvalent', emoji: '⚽🏉', nom: 'Polyvalent',
    aide: 'Parier au football et au rugby',
    test: (p) => p.some((x) => sportDe(x) === 'football')
      && p.some((x) => sportDe(x) === 'rugby') },
  { id: 'tour-europe', emoji: '🇪🇺', nom: 'Tour d’Europe',
    aide: 'Parier dans les 5 grands championnats européens',
    test: (p) => {
      const vus = new Set(p.map((x) => x.match?.league?.external_id)
        .filter((id) => GRANDS_CHAMPIONNATS.has(id)));
      return vus.size >= GRANDS_CHAMPIONNATS.size;
    } },
  { id: 'globe-trotter', emoji: '🌍', nom: 'Globe-trotter',
    aide: 'Parier dans 10 compétitions différentes',
    test: (p) => new Set(p.map((x) => x.match?.league?.id).filter(Boolean)).size >= 10 },
  { id: 'assidu', emoji: '📅', nom: 'Assidu',
    aide: 'Parier sur 7 jours différents',
    test: (p) => new Set(p.map((x) => (x.placed_at || '').slice(0, 10))
      .filter(Boolean)).size >= 7 },
  { id: 'centurion', emoji: '💯', nom: 'Centurion',
    aide: '100 paris joués',
    test: (p) => p.filter(estJoue).length >= 100 },
  { id: 'fortune', emoji: '🏦', nom: 'Fortune',
    aide: 'Gagner 5 000 Éclats cumulés sur tes paris',
    test: (p) => p.filter((x) => x.status === 'won')
      .reduce((s, x) => s + gainPari(x), 0) >= 5000 },
];

// Retourne la liste des badges avec leur état débloqué
export function evaluerBadges(paris) {
  return BADGES.map((b) => ({ ...b, debloque: b.test(paris) }));
}
