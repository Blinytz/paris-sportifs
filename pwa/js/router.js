// Router à hash : GitHub Pages ne réécrit pas les URL, les routes
// dynamiques deviennent #/equipe/{id}, #/match/{id}, etc.

import { pageAccueil } from './pages/accueil.js';
import { pageClassement } from './pages/classement.js';
import { pageEquipe } from './pages/equipe.js';
import { pageMatch } from './pages/match.js';
import { pageMesParis } from './pages/mes-paris.js';
import { pageReglages } from './pages/reglages.js';

const ROUTES = [
  { motif: /^\/?$/, rendu: pageAccueil, onglet: 'paris' },
  { motif: /^\/accueil$/, rendu: pageAccueil, onglet: 'paris' },
  { motif: /^\/equipe\/([0-9a-f-]+)$/, rendu: pageEquipe, onglet: 'paris' },
  { motif: /^\/classement\/([0-9a-f-]+)$/, rendu: pageClassement, onglet: 'paris' },
  { motif: /^\/match\/([0-9a-f-]+)$/, rendu: pageMatch, onglet: 'paris' },
  { motif: /^\/mes-paris$/, rendu: pageMesParis, onglet: 'mes-paris' },
  { motif: /^\/reglages$/, rendu: pageReglages, onglet: 'reglages' },
];

export async function naviguer() {
  const chemin = location.hash.replace(/^#/, '') || '/';
  const conteneur = document.getElementById('app');
  for (const route of ROUTES) {
    const m = chemin.match(route.motif);
    if (m) {
      document.querySelectorAll('#onglets a').forEach((a) => {
        a.classList.toggle('actif', a.dataset.route === route.onglet);
      });
      await route.rendu(conteneur, ...m.slice(1));
      window.scrollTo(0, 0);
      return;
    }
  }
  conteneur.innerHTML = '<div class="vide"><span class="emoji">🤷</span>'
    + '<p>Page introuvable.</p></div>';
}

export function demarrerRouter() {
  window.addEventListener('hashchange', naviguer);
  return naviguer();
}
