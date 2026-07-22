// Utilitaires d'affichage partagés : formatage, squelettes, toasts,
// et les animations de collecte des Éclats (pièces + compteur qui roule).

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
  return iso ? FMT_DATE.format(new Date(iso)) : '?';
}

export function jour(iso) {
  return iso ? FMT_JOUR.format(new Date(iso)) : '?';
}

export function heure(iso) {
  return iso ? new Date(iso).toLocaleTimeString('fr-FR',
    { hour: '2-digit', minute: '2-digit' }) : '?';
}

export function nombre(valeur, decimales = 0) {
  if (valeur === undefined || valeur === null || valeur === '') return '?';
  return Number(valeur).toLocaleString('fr-FR', {
    minimumFractionDigits: decimales, maximumFractionDigits: decimales,
  });
}

// Les Éclats sont indivisibles : jamais de centimes, tout montant est
// arrondi à l'unité supérieure (comme les calculs côté base de données).
export function eclats(valeur) {
  return nombre(Math.ceil(Number(valeur) || 0));
}

// Clé de date locale (YYYY-MM-DD) d'un instant ISO
export function cleJour(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function ordinal(position) {
  if (position === undefined || position === null) return '?';
  return position === 1 ? '1er' : `${position}e`;
}

// Blason d'équipe (logo Highlightly) avec repli sur les initiales
export function blason(equipe) {
  const nom = equipe?.name || '';
  if (equipe?.logo_url) {
    return `<img class="blason" src="${echapper(equipe.logo_url)}" alt=""
      loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),
      {className:'blason-vide',textContent:'${echapper(initiales(nom))}'}))">`;
  }
  return `<div class="blason-vide">${echapper(initiales(nom))}</div>`;
}

export function initiales(nom) {
  return (nom || '?').split(/\s+/).slice(0, 2).map((m) => m[0] || '')
    .join('').toUpperCase();
}

export function badgesForme(lastResults) {
  if (!lastResults) return '<span class="faible">aucun</span>';
  return lastResults.split(',').map((code) =>
    `<span class="forme forme-${echapper(code)}">${echapper(code)}</span>`).join('');
}

export function formeDepuisMatchs(matchs, teamId, fenetre) {
  return matchs.slice(0, fenetre).map((m) => {
    if (m.score_home === m.score_away) return 'N';
    const victoireDomicile = m.score_home > m.score_away;
    const estDomicile = m.home_team_id === teamId;
    return victoireDomicile === estDomicile ? 'V' : 'D';
  }).join(',') || null;
}

export function probaImplicite(cote) {
  if (!cote) return '?';
  return `${Math.round(100 / Number(cote))} %`;
}

// Libellé explicite du bonus obtenu par un pari réglé
export function libelleBonus(pari, scoreHome, scoreAway) {
  const m = Number(pari.bonus_multiplier) || 1;
  const facteur = `×${m.toLocaleString('fr-FR', { maximumFractionDigits: 2 })}`;
  if (pari.predicted_home == null || scoreHome == null || scoreAway == null) {
    return m > 1 ? `bonus ${facteur}` : 'sans bonus';
  }
  if (pari.predicted_home === scoreHome && pari.predicted_away === scoreAway) {
    return `score exact ${facteur}`;
  }
  if ((pari.predicted_home - pari.predicted_away) === (scoreHome - scoreAway)) {
    return pari.predicted_home === pari.predicted_away
      ? `bon écart, nul ${facteur}` : `bon écart ${facteur}`;
  }
  return 'bonne issue';
}

// Gain effectif d'un pari gagné (mise × cote × bonus), en Éclats entiers
export function gainPari(pari) {
  return Math.ceil(Number(pari.potential_payout)
    * (Number(pari.bonus_multiplier) || 1));
}

export function lienClassementExterne(ligue) {
  const q = encodeURIComponent(`classement ${ligue?.name || ''} ${
    ligue?.country && ligue.country !== 'World' ? ligue.country : ''}`.trim());
  return `https://www.google.com/search?q=${q}`;
}

// ---------- États de chargement et messages ----------

export function squelettes(n = 4) {
  return Array.from({ length: n }, () => '<div class="squelette"></div>').join('');
}

export function vide(emoji, titre, sous = '') {
  return `<div class="vide"><span class="emoji">${emoji}</span>
    <p>${echapper(titre)}</p>
    ${sous ? `<p class="faible">${echapper(sous)}</p>` : ''}</div>`;
}

export function erreur(e) {
  return `<div class="vide"><span class="emoji">⚠️</span>
    <p class="erreur">${echapper(e.message || e)}</p></div>`;
}

export function toast(message, type = '') {
  const zone = document.getElementById('toasts');
  if (!zone) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  zone.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 2600);
}

export function vibrer(ms = 12) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

// ---------- Animations de collecte ----------

// Compteur qui roule de `depuis` vers `vers` (easing doux).
// Filet de sécurité : requestAnimationFrame est suspendu quand l'onglet
// passe en arrière-plan ; un minuteur garantit alors la valeur finale.
export function animerCompteur(el, depuis, vers, duree = 900) {
  const valeurFinale = `${eclats(vers)} ✦`;
  if (document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = valeurFinale;
    return Promise.resolve();
  }
  const debut = performance.now();
  const ecart = vers - depuis;
  return new Promise((resoudre) => {
    let fini = false;
    const terminer = () => {
      if (fini) return;
      fini = true;
      el.textContent = valeurFinale;
      resoudre();
    };
    const etape = (maintenant) => {
      if (fini) return;
      const t = Math.min(1, (maintenant - debut) / duree);
      // easeOutCubic : rapide puis ralentit
      const p = 1 - Math.pow(1 - t, 3);
      el.textContent = `${eclats(Math.round(depuis + ecart * p))} ✦`;
      if (t < 1) requestAnimationFrame(etape);
      else terminer();
    };
    requestAnimationFrame(etape);
    setTimeout(terminer, duree + 400);
  });
}

// Fait jaillir des pièces depuis un élément vers la pilule de solde.
// Retourne une promesse résolue quand la dernière pièce est arrivée.
export function envoyerPieces(source, nombreDePieces = 6) {
  const cible = document.getElementById('solde');
  if (!source || !cible || document.hidden
      || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return Promise.resolve();
  }
  const depart = source.getBoundingClientRect();
  const arrivee = cible.getBoundingClientRect();
  const cx = arrivee.left + arrivee.width / 2 - 13;
  const cy = arrivee.top + arrivee.height / 2 - 13;

  const vols = [];
  for (let i = 0; i < nombreDePieces; i += 1) {
    const piece = document.createElement('div');
    piece.className = 'piece';
    piece.textContent = '✦';
    const x0 = depart.left + depart.width * (0.2 + 0.6 * Math.random()) - 13;
    const y0 = depart.top + depart.height * (0.25 + 0.5 * Math.random()) - 13;
    piece.style.left = `${x0}px`;
    piece.style.top = `${y0}px`;
    document.body.appendChild(piece);

    // Courbe : petite impulsion vers le haut, puis chute vers le solde
    const sommetX = (x0 + cx) / 2 + (Math.random() - 0.5) * 90;
    const sommetY = Math.min(y0, cy) - 70 - Math.random() * 50;
    const anim = piece.animate([
      { transform: 'translate(0,0) scale(.6)', opacity: 0 },
      { transform: `translate(${sommetX - x0}px, ${sommetY - y0}px) scale(1.1)`,
        opacity: 1, offset: 0.45 },
      { transform: `translate(${cx - x0}px, ${cy - y0}px) scale(.5)`, opacity: .9 },
    ], {
      duration: 620 + Math.random() * 220,
      delay: i * 55,
      easing: 'cubic-bezier(.4,0,.5,1)',
      fill: 'forwards',
    });
    // Retrait garanti : anim.finished ne se résout pas si l'onglet passe
    // en arrière-plan, le minuteur évite d'oublier des pièces à l'écran
    const retirer = () => piece.remove();
    setTimeout(retirer, 1600 + i * 55);
    vols.push(anim.finished.catch(() => {}).then(retirer));
  }
  return Promise.all(vols);
}

// Pulsation de la pilule + compteur qui roule. Les pièces sont lancées
// par la page (une volée par carte récoltée), afin que le compteur ne
// soit animé qu'une seule fois même lors d'une récolte groupée.
export function animerSolde(ancienSolde, nouveauSolde, delai = 420) {
  const pastille = document.getElementById('solde');
  if (!pastille) return Promise.resolve();
  vibrer(18);
  return new Promise((resoudre) => {
    setTimeout(() => {
      pastille.classList.add('encaisse');
      setTimeout(() => pastille.classList.remove('encaisse'), 260);
      animerCompteur(pastille, ancienSolde, nouveauSolde).then(resoudre);
    }, delai);
  });
}
