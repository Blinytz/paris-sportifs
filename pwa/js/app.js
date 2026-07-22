// Point d'entrée : session, écran de connexion, solde, badge de collecte,
// router.

import { connexion, deconnexion, utilisateur } from './supabase.js';
import { parisACollecter, soldeEclats } from './api.js';
import { demarrerRouter } from './router.js';
import { animerSolde, echapper, eclats } from './ui.js';

// Solde courant, tenu à jour ici : les pages l'utilisent comme point de
// départ des animations de collecte.
export const etat = { solde: 0 };

async function majSolde({ anime = false } = {}) {
  const zone = document.getElementById('solde');
  try {
    const nouveau = await soldeEclats();
    if (anime && nouveau !== etat.solde) {
      await animerSolde(etat.solde, nouveau);
    } else {
      zone.textContent = `${eclats(nouveau)} ✦`;
    }
    etat.solde = nouveau;
    zone.title = `${eclats(nouveau)} Éclats`;
  } catch {
    zone.textContent = '✦';
  }
}

async function majBadgeCollecte() {
  const badge = document.getElementById('badge-collecte');
  const pastille = document.getElementById('a-recolter');
  try {
    const enAttente = await parisACollecter();
    badge.hidden = enAttente.length === 0;
    badge.textContent = enAttente.length;

    // Montant en attente, toujours visible : ces Éclats ne sont pas
    // dans le solde tant qu'ils n'ont pas été récoltés
    const total = enAttente.reduce((somme, p) => somme + (p.status === 'won'
      ? Number(p.potential_payout) * (Number(p.bonus_multiplier) || 1)
      : Number(p.stake_eclats)), 0);
    pastille.hidden = total <= 0;
    pastille.textContent = `+${eclats(total)} ✦ à récolter`;
  } catch {
    badge.hidden = true;
    pastille.hidden = true;
  }
}

// Les pages émettent ces événements après une action sur le portefeuille
window.addEventListener('eclats-changes', () => {
  majSolde();
  majBadgeCollecte();
});
// Émis une seule fois par récolte (même groupée) : anime le compteur
window.addEventListener('eclats-collectes', () => {
  majSolde({ anime: true });
  majBadgeCollecte();
});

function afficherConnexion(message = '') {
  document.getElementById('coquille').hidden = true;
  const zone = document.getElementById('connexion');
  zone.hidden = false;
  zone.innerHTML = `
    <form class="carte">
      <h1>Paris <span style="color:var(--or-fonce)">✦</span></h1>
      <p class="muet sous">Pronostics en Éclats, foot et rugby.</p>
      ${message ? `<p class="erreur">${echapper(message)}</p>` : ''}
      <label>E-mail
        <input type="email" name="email" required autocomplete="username"></label>
      <label>Mot de passe
        <input type="password" name="mdp" required autocomplete="current-password"></label>
      <button type="submit" class="btn-or">Se connecter</button>
    </form>`;
  zone.querySelector('form').addEventListener('submit', async (evt) => {
    evt.preventDefault();
    const donnees = new FormData(evt.target);
    const bouton = evt.target.querySelector('button');
    bouton.disabled = true;
    bouton.textContent = 'Connexion…';
    try {
      await connexion(donnees.get('email'), donnees.get('mdp'));
      demarrerApp();
    } catch (e) {
      afficherConnexion(e.message);
    }
  });
}

function demarrerApp() {
  document.getElementById('connexion').hidden = true;
  document.getElementById('coquille').hidden = false;
  majSolde();
  majBadgeCollecte();
  demarrerRouter();
}

document.getElementById('deconnexion').addEventListener('click', () => {
  deconnexion();
  afficherConnexion();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* hors ligne ok */ });
}

if (utilisateur()) demarrerApp();
else afficherConnexion();
