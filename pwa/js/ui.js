// Petits utilitaires d'affichage partagés par les pages.

export function html(fragments, ...valeurs) {
  // Gabarit avec échappement automatique des valeurs interpolées.
  // Utiliser brut() pour injecter du HTML déjà sûr.
  return fragments.reduce((sortie, morceau, i) => {
    const v = valeurs[i - 1];
    return sortie + (v && v.__brut ? v.html : echapper(v)) + morceau;
  });
}

export function brut(htmlSur) {
  return { __brut: true, html: htmlSur };
}

export function echapper(valeur) {
  if (valeur === undefined || valeur === null) return '';
  return String(valeur)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

const FMT_DATE = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'short', day: 'numeric', month: 'short',
  hour: '2-digit', minute: '2-digit',
});
const FMT_JOUR = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long', day: 'numeric', month: 'long',
});

export function dateHeure(iso) {
  return iso ? FMT_DATE.format(new Date(iso)) : '—';
}

export function jour(iso) {
  return iso ? FMT_JOUR.format(new Date(iso)) : '—';
}

export function nombre(valeur, decimales = 0) {
  if (valeur === undefined || valeur === null) return '—';
  return Number(valeur).toLocaleString('fr-FR', {
    minimumFractionDigits: decimales, maximumFractionDigits: decimales,
  });
}

// "V,N,D,V,V" -> pastilles colorées (plus récent en premier)
export function badgesForme(lastResults) {
  if (!lastResults) return '<span class="muet">—</span>';
  return lastResults.split(',').map((code) =>
    `<span class="forme forme-${echapper(code)}">${echapper(code)}</span>`).join('');
}

// Forme calculée depuis une liste de matchs terminés (tri décroissant),
// du point de vue de teamId — pour les formes non stockées (globale,
// domicile seul, extérieur seul, ou vue avant-match).
export function formeDepuisMatchs(matchs, teamId, fenetre) {
  return matchs.slice(0, fenetre).map((m) => {
    if (m.score_home === m.score_away) return 'N';
    const victoireDomicile = m.score_home > m.score_away;
    const estDomicile = m.home_team_id === teamId;
    return victoireDomicile === estDomicile ? 'V' : 'D';
  }).join(',') || null;
}

// Probabilité implicite affichable à partir d'une cote
export function probaImplicite(cote) {
  if (!cote) return '—';
  return `${Math.round(100 / Number(cote))} %`;
}

// Libellé explicite du bonus appliqué à un pari réglé, déduit du
// pronostic face au score réel (le multiplicateur stocké en base fait foi
// pour le montant ; le libellé explique d'où il vient).
export function libelleBonus(pari, scoreHome, scoreAway) {
  const m = Number(pari.bonus_multiplier) || 1;
  const facteur = `×${Number(m).toLocaleString('fr-FR', { maximumFractionDigits: 2 })}`;
  if (pari.predicted_home == null || scoreHome == null || scoreAway == null) {
    return m > 1 ? `bonus ${facteur}` : 'cote seule, sans bonus';
  }
  if (pari.predicted_home === scoreHome && pari.predicted_away === scoreAway) {
    return `score exact ${facteur}`;
  }
  if ((pari.predicted_home - pari.predicted_away) === (scoreHome - scoreAway)) {
    return pari.predicted_home === pari.predicted_away
      ? `bon écart (nul) ${facteur}` : `bon écart ${facteur}`;
  }
  return 'bonne issue seule, sans bonus';
}

// "1" -> "1er", "3" -> "3e"
export function ordinal(position) {
  if (position === undefined || position === null) return '—';
  return position === 1 ? '1er' : `${position}e`;
}

// Lien de secours vers un classement externe quand aucune donnée
// /standings n'est encore en base pour ce championnat.
export function lienClassementExterne(ligue) {
  const q = encodeURIComponent(`classement ${ligue?.name || ''} ${ligue?.country && ligue.country !== 'World' ? ligue.country : ''}`.trim());
  return `https://www.google.com/search?q=${q}`;
}

export function chargement() {
  return '<p class="muet">Chargement…</p>';
}

export function erreur(e) {
  return `<p class="erreur">Erreur : ${echapper(e.message || e)}</p>`;
}
