// Onglet Profil : progression du pronostiqueur (paliers), primes à
// réclamer, et badges d'accomplissement. La progression est propre aux
// paris (points de pronostiqueur), jamais liée au solde partagé.

import {
  listePaliers, mesParis, pointsPronostiqueur, primesReclamees,
  reclamerPrimesPaliers,
} from '../api.js';
import { evaluerBadges } from '../badges.js';
import {
  echapper, eclats, envoyerPieces, erreur, gainPari, nombre, squelettes,
  toast, vide,
} from '../ui.js';

// Couleur d'accent par division (bronze → or → prestige)
const COULEUR_DIVISION = {
  D4: '#b08d57', D3: '#9aa3ad', D2: '#d9b23c', D1: '#4a86c5',
  International: '#1f9d55', "Ballon d'Or": '#c9a227',
};

export async function pageProfil(conteneur) {
  conteneur.innerHTML = squelettes(3);
  try {
    const [paliers, pp, reclamees, paris] = await Promise.all([
      listePaliers(), pointsPronostiqueur(), primesReclamees(), mesParis(),
    ]);
    rendre(conteneur, paliers, Number(pp) || 0, reclamees, paris);
  } catch (e) {
    conteneur.innerHTML = erreur(e);
  }
}

function rendre(conteneur, paliers, pp, reclamees, paris) {
  // Palier courant = le plus élevé dont le seuil est atteint
  let courant = paliers[0];
  let suivant = null;
  for (const p of paliers) {
    if (pp >= p.pp_min) courant = p;
    else { suivant = suivant || p; }
  }
  suivant = paliers.find((p) => p.pp_min > pp) || null;

  const primesDues = paliers.filter(
    (p) => pp >= p.pp_min && p.eclats_bonus > 0 && !reclamees.has(p.idx));
  const totalDu = primesDues.reduce((s, p) => s + Number(p.eclats_bonus), 0);

  const gagnesCumules = paris.filter((x) => x.status === 'won')
    .reduce((s, x) => s + gainPari(x), 0);
  const badges = evaluerBadges(paris);
  const debloques = badges.filter((b) => b.debloque).length;

  const couleur = COULEUR_DIVISION[courant.division] || 'var(--or)';
  const progression = suivant
    ? Math.min(1, (pp - courant.pp_min) / (suivant.pp_min - courant.pp_min)) : 1;

  conteneur.innerHTML = `
    <h1>Profil</h1>

    <div class="carte centre carte-palier" style="--accent-palier:${couleur}">
      <div class="ecusson-palier">${echapper(initialesPalier(courant))}</div>
      <div class="nom-palier">${echapper(courant.name)}</div>
      <div class="faible">${nombre(pp)} points de pronostiqueur</div>
      ${suivant ? `
        <div class="barre-progression">
          <div class="barre-remplie" style="width:${(progression * 100).toFixed(1)}%"></div>
        </div>
        <div class="faible">${nombre(suivant.pp_min - pp)} points avant
          ${echapper(suivant.name)}</div>`
        : '<div class="faible">Palier maximum atteint 🏆</div>'}
    </div>

    ${totalDu > 0 ? `
      <div class="bandeau-collecte" id="bandeau-primes">
        <div class="details">
          <div class="montant">🎁 ${primesDues.length} prime${primesDues.length > 1 ? 's' : ''}
            de palier</div>
          <div class="sous">Récompense de progression à récolter.</div>
        </div>
        <button class="btn-or" id="reclamer-primes">Réclamer</button>
      </div>` : ''}

    <div class="grille-tuiles" style="margin-bottom:.9rem">
      ${tuile(courant.division, 'division')}
      ${tuile(`${eclats(gagnesCumules)} ✦`, 'gagnés au total')}
      ${tuile(`${debloques}/${badges.length}`, 'badges')}
    </div>

    <h2>Échelle des paliers</h2>
    <div class="carte echelle">
      ${paliers.map((p) => lignePalier(p, courant, pp, reclamees)).join('')}
    </div>

    <h2>Badges</h2>
    <div class="grille-badges">
      ${badges.map(carteBadge).join('')}
    </div>`;

  const bouton = conteneur.querySelector('#reclamer-primes');
  if (bouton) {
    bouton.addEventListener('click', async () => {
      bouton.disabled = true;
      bouton.textContent = '…';
      try {
        const total = await reclamerPrimesPaliers();
        envoyerPieces(conteneur.querySelector('#bandeau-primes'), 10);
        window.dispatchEvent(new Event('eclats-collectes'));
        toast(`+${eclats(total)} ✦ de prime récoltés`, 'succes');
        setTimeout(() => pageProfil(conteneur), 900);
      } catch (e) {
        bouton.disabled = false;
        bouton.textContent = 'Réclamer';
        toast(e.message, 'echec');
      }
    });
  }
}

function initialesPalier(p) {
  if (p.division === 'Ballon d\'Or') return '🏆';
  if (p.division === 'International') return '🌍';
  return p.division;   // D4..D1
}

function tuile(valeur, libelle) {
  return `<div class="tuile"><span class="valeur">${echapper(valeur)}</span>
    <span class="libelle">${echapper(libelle)}</span></div>`;
}

function lignePalier(p, courant, pp, reclamees) {
  const atteint = pp >= p.pp_min;
  const estCourant = p.idx === courant.idx;
  const couleur = COULEUR_DIVISION[p.division] || 'var(--or)';
  const etat = estCourant ? 'palier-courant' : atteint ? 'palier-atteint' : 'palier-verrouille';
  const prime = p.eclats_bonus > 0
    ? (atteint
        ? (reclamees.has(p.idx) ? '<span class="faible">reçue</span>'
            : '<span class="gain-pastille collecte">à réclamer</span>')
        : `<span class="faible">${eclats(p.eclats_bonus)} ✦</span>`)
    : '';
  return `
    <div class="ligne-palier ${etat}">
      <span class="pastille-division" style="background:${couleur}">
        ${echapper(initialesPalier(p))}</span>
      <span class="nom">${echapper(p.name)}</span>
      <span class="faible seuil">${nombre(p.pp_min)} PP</span>
      ${prime}
    </div>`;
}

function carteBadge(b) {
  return `
    <div class="badge-carte ${b.debloque ? 'debloque' : 'verrouille'}"
         title="${echapper(b.aide)}">
      <span class="badge-emoji">${b.debloque ? b.emoji : '🔒'}</span>
      <span class="badge-nom">${echapper(b.nom)}</span>
      <span class="badge-aide">${echapper(b.aide)}</span>
    </div>`;
}
