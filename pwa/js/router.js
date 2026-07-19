// Router à hash : GitHub Pages ne sait pas réécrire les URL, les routes
// dynamiques de la spec (/equipe/{id}, /match/{id}) deviennent
// #/equipe/{id} et #/match/{id}.

import { pageAccueil } from './pages/accueil.js';
import { pageEquipe } from './pages/equipe.js';
import { pageMatch } from './pages/match.js';
import { pageMesParis } from './pages/mes-paris.js';
import { pageReglages } from './pages/reglages.js';

const ROUTES = [
  { motif: /^\/?$/, rendu: pageAccueil },
  { motif: /^\/accueil$/, rendu: pageAccueil },
  { motif: /^\/equipe\/([0-9a-f-]+)$/, rendu: pageEquipe },
  { motif: /^\/match\/([0-9a-f-]+)$/, rendu: pageMatch },
  { motif: /^\/mes-paris$/, rendu: pageMesParis },
  { motif: /^\/reglages$/, rendu: pageReglages },
];

export async function naviguer() {
  const chemin = location.hash.replace(/^#/, '') || '/';
  const conteneur = document.getElementById('app');
  for (const route of ROUTES) {
    const m = chemin.match(route.motif);
    if (m) {
      document.querySelectorAll('nav a').forEach((a) => {
        a.classList.toggle('actif', a.getAttribute('href') === `#${chemin}`);
      });
      await route.rendu(conteneur, ...m.slice(1));
      window.scrollTo(0, 0);
      return;
    }
  }
  conteneur.innerHTML = '<p class="erreur">Page introuvable.</p>';
}

export function demarrerRouter() {
  window.addEventListener('hashchange', naviguer);
  return naviguer();
}
