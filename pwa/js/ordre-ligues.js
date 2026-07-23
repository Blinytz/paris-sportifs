// Ordre d'affichage des compétitions dans les filtres (décidé le
// 23/07/2026). Les identifiants sont ceux de Highlightly.
//
// Football : grands championnats européens (France, Angleterre, Espagne,
// Allemagne, Italie), MLS, autres championnats, coupes nationales dans
// le même ordre de pays, coupes continentales de clubs (Europe puis
// Amérique du Sud), enfin les compétitions de sélections (Mondial et
// Euro d'abord). Le rugby ferme la marche.

const ORDRE = [
  // Championnats européens majeurs
  52695,   // Ligue 1
  53546,   // Ligue 2
  33973,   // Premier League
  119924,  // La Liga
  67162,   // Bundesliga
  115669,  // Serie A (Italie)
  216087,  // Major League Soccer
  // Autres championnats
  61205,   // Serie A (Brésil)
  223746,  // Liga MX
  84182,   // J1 League
  249276,  // K League 1
  160772,  // A-League
  55248,   // D1 féminine
  // Coupes nationales, dans l'ordre des pays ci-dessus
  56950,   // Coupe de France
  39079,   // FA Cup
  122477,  // Copa del Rey
  69715,   // DFB Pokal
  117371,  // Coppa Italia
  // Coupes continentales de clubs
  2486,    // Ligue des champions
  3337,    // Ligue Europa
  722432,  // Ligue Europa Conference
  11847,   // Copa Libertadores
  10145,   // Copa Sudamericana
  // Sélections nationales
  1635,    // Coupe du monde
  4188,    // Euro
  5039,    // Ligue des nations UEFA
  8443,    // Copa America
  5890,    // Coupe d'Afrique des nations
  6741,    // Coupe d'Asie
  19506,   // Gold Cup
  456920,  // Ligue des nations CONCACAF
  // Rugby
  14400,   // Top 14
  15251,   // Pro D2
  46738,   // Champions Cup
  45036,   // Challenge Cup
  44185,   // Tournoi des Six Nations
  48440,   // Six Nations U20
  73119,   // Rugby Championship
  124179,  // Nations Championship
  77374,   // Pacific Nations Cup
  59503,   // Coupe du monde de rugby
];

const RANG = new Map(ORDRE.map((id, i) => [id, i]));

// Emblème affiché devant chaque compétition. Par identifiant pour les
// compétitions supranationales (une confédération n'a pas de drapeau),
// sinon par pays.
const EMBLEME_PAR_LIGUE = {
  2486: '🇪🇺', 3337: '🇪🇺', 722432: '🇪🇺',   // coupes d'Europe de clubs
  4188: '🇪🇺', 5039: '🇪🇺',                  // Euro, Ligue des nations
  11847: '🌎', 10145: '🌎',                  // CONMEBOL
  8443: '🌎', 19506: '🌎', 456920: '🌎',      // Copa America, CONCACAF
  5890: '🌍',                                // Coupe d'Afrique
  6741: '🌏',                                // Coupe d'Asie
  1635: '🏆', 59503: '🏆',                    // Coupes du monde
  46738: '🇪🇺', 45036: '🇪🇺',                 // coupes d'Europe de rugby
  44185: '🇪🇺', 48440: '🇪🇺',                 // Tournois des Six Nations
  73119: '🌏',                               // Rugby Championship
  124179: '🌍',                              // Nations Championship
  77374: '🌊',                               // Pacific Nations Cup
};

const EMBLEME_PAR_PAYS = {
  France: '🇫🇷', England: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', Spain: '🇪🇸', Germany: '🇩🇪',
  Italy: '🇮🇹', USA: '🇺🇸', Brazil: '🇧🇷', Mexico: '🇲🇽', Japan: '🇯🇵',
  'South Korea': '🇰🇷', Australia: '🇦🇺', Portugal: '🇵🇹',
  Netherlands: '🇳🇱', Belgium: '🇧🇪', Argentina: '🇦🇷', Europe: '🇪🇺',
};

export function embleme(ligue) {
  if (!ligue) return '';
  if (EMBLEME_PAR_LIGUE[ligue.external_id]) return EMBLEME_PAR_LIGUE[ligue.external_id];
  if (EMBLEME_PAR_PAYS[ligue.country]) return EMBLEME_PAR_PAYS[ligue.country];
  return ligue.sport === 'rugby' ? '🏉' : '⚽';
}

// Deux compétitions portent le nom « Serie A » : on précise le pays pour
// les distinguer dans les filtres.
const NOMS_AMBIGUS = new Set(['Serie A', 'World Cup']);

export function nomLigue(ligue) {
  if (!ligue) return '';
  if (NOMS_AMBIGUS.has(ligue.name) && ligue.country && ligue.country !== 'World') {
    return `${ligue.name} ${paysCourt(ligue.country)}`;
  }
  return ligue.name;
}

function paysCourt(pays) {
  const abreviations = {
    Italy: 'Italie', Brazil: 'Brésil', France: 'France', England: 'Angleterre',
    Spain: 'Espagne', Germany: 'Allemagne', Japan: 'Japon', Mexico: 'Mexique',
    Australia: 'Australie', 'South Korea': 'Corée', USA: 'USA',
  };
  return `(${abreviations[pays] || pays})`;
}

// Trie une liste de compétitions selon l'ordre ci-dessus ; celles qui n'y
// figurent pas (ajouts futurs) passent à la fin, rugby en dernier.
export function trierLigues(ligues) {
  return [...ligues].sort((a, b) => {
    const ra = RANG.has(a.external_id) ? RANG.get(a.external_id)
      : ORDRE.length + (a.sport === 'rugby' ? 100 : 0);
    const rb = RANG.has(b.external_id) ? RANG.get(b.external_id)
      : ORDRE.length + (b.sport === 'rugby' ? 100 : 0);
    if (ra !== rb) return ra - rb;
    return (a.name || '').localeCompare(b.name || '', 'fr');
  });
}
