// Point d'entrée : session, écran de connexion, header (solde), router.

import { connexion, deconnexion, utilisateur } from './supabase.js';
import { soldeEclats } from './api.js';
import { demarrerRouter } from './router.js';
import { echapper, nombre } from './ui.js';

async function majSolde() {
  const zone = document.getElementById('solde');
  try {
    const solde = await soldeEclats();
    zone.textContent = `${nombre(solde)} ✦`;
    zone.title = `${nombre(solde)} Éclats`;
  } catch {
    zone.textContent = '✦ ?';
  }
}

// Les pages déclenchent cet événement après un pari accepté
window.addEventListener('eclats-changes', majSolde);

function afficherConnexion(message = '') {
  document.getElementById('coquille').hidden = true;
  const zone = document.getElementById('connexion');
  zone.hidden = false;
  zone.innerHTML = `
    <form id="formulaire-connexion" class="carte">
      <h1>Paris Sportifs ✦</h1>
      <p class="muet">Compte partagé des PWA (Supabase).</p>
      ${message ? `<p class="erreur">${echapper(message)}</p>` : ''}
      <label>E-mail <input type="email" name="email" required autocomplete="username"></label>
      <label>Mot de passe <input type="password" name="mdp" required autocomplete="current-password"></label>
      <button type="submit">Se connecter</button>
    </form>`;
  zone.querySelector('form').addEventListener('submit', async (evt) => {
    evt.preventDefault();
    const donnees = new FormData(evt.target);
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
