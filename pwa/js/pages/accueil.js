// Accueil : paris rapides. Chaque match à venir porte deux champs de
// score ; dès que les deux sont remplis, le pari part automatiquement
// avec la mise par défaut (model_settings.default_stake).
// Pour ajuster la mise ou voir les stats, on passe par la page du match.

import {
  dernieresCotes, listeLigues, lireReglages, mesParisSurMatchs,
  placerPari, prochainsMatchs,
} from '../api.js';
import { chargement, echapper, erreur, jour, nombre } from '../ui.js';

// Délai après la dernière frappe avant d'envoyer le pari : laisse le
// temps de saisir un score à deux chiffres (rugby) ou de se corriger.
const DELAI_ENVOI = 1200;

const filtres = { sport: '', leagueId: '' };
let liguesCache = null;

export async function pageAccueil(conteneur) {
  conteneur.innerHTML = chargement();
  try {
    liguesCache = liguesCache || await listeLigues();
    await rendre(conteneur);
  } catch (e) {
    conteneur.innerHTML = erreur(e);
  }
}

async function rendre(conteneur) {
  const [matchs, reglages] = await Promise.all([
    prochainsMatchs(filtres.leagueId
      ? { leagueId: filtres.leagueId }
      : { sport: filtres.sport || undefined }),
    lireReglages(),
  ]);
  const ids = matchs.map((m) => m.id);
  const [cotes, paris] = await Promise.all([
    dernieresCotes(ids), mesParisSurMatchs(ids),
  ]);
  const mise = Number(reglages?.default_stake) || 100;

  const liguesVisibles = liguesCache.filter(
    (l) => !filtres.sport || l.sport === filtres.sport);
  const optionsLigues = liguesVisibles.map((l) =>
    `<option value="${l.id}" ${l.id === filtres.leagueId ? 'selected' : ''}>
      ${echapper(l.name)}${l.country && l.country !== 'World' ? ` (${echapper(l.country)})` : ''}
    </option>`).join('');

  const parJour = new Map();
  for (const m of matchs) {
    const cle = jour(m.kickoff_at);
    if (!parJour.has(cle)) parJour.set(cle, []);
    parJour.get(cle).push(m);
  }

  conteneur.innerHTML = `
    <div class="filtres">
      <select id="filtre-sport">
        <option value="">Tous les sports</option>
        <option value="football" ${filtres.sport === 'football' ? 'selected' : ''}>Football</option>
        <option value="rugby" ${filtres.sport === 'rugby' ? 'selected' : ''}>Rugby</option>
      </select>
      <select id="filtre-ligue">
        <option value="">Toutes les compétitions</option>
        ${optionsLigues}
      </select>
    </div>
    <p class="muet">Pari rapide : saisis un score, la mise de
      <strong>${nombre(mise)} ✦</strong> part toute seule.
      Pour miser autrement, ouvre le match.</p>
    ${matchs.length === 0 ? '<p class="muet">Aucun match à venir dans la fenêtre synchronisée.</p>' : ''}
    ${[...parJour.entries()].map(([libelle, liste]) => `
      <h2 class="jour">${echapper(libelle)}</h2>
      ${liste.map((m) => carteMatch(m, cotes.get(m.id), paris.get(m.id))).join('')}
    `).join('')}`;

  conteneur.querySelector('#filtre-sport').addEventListener('change', (evt) => {
    filtres.sport = evt.target.value;
    filtres.leagueId = '';
    rendre(conteneur);
  });
  conteneur.querySelector('#filtre-ligue').addEventListener('change', (evt) => {
    filtres.leagueId = evt.target.value;
    rendre(conteneur);
  });
  brancherParisRapides(conteneur, mise);
}

function carteMatch(m, cote, parisDuMatch) {
  const heure = new Date(m.kickoff_at).toLocaleTimeString('fr-FR',
    { hour: '2-digit', minute: '2-digit' });
  const dejaParie = (parisDuMatch || [])
    .map((p) => `${p.predicted_home}-${p.predicted_away}`).join(', ');
  return `
    <div class="carte carte-match" data-match="${m.id}" data-parie="${dejaParie ? '1' : ''}">
      <div class="carte-match-entete">
        <a class="muet" href="#/match/${m.id}">${echapper(m.league?.name || '')} · ${heure}</a>
        <span class="pastille">${m.league?.sport === 'rugby' ? '🏉' : '⚽'}</span>
      </div>
      <div class="carte-match-equipes">
        <a href="#/match/${m.id}">${echapper(m.home?.name)}</a>
        <span class="muet">vs</span>
        <a href="#/match/${m.id}">${echapper(m.away?.name)}</a>
      </div>
      ${cote ? `
      <div class="carte-match-cotes">
        <span>1 · ${nombre(cote.home_odds, 2)}</span>
        ${cote.draw_odds ? `<span>N · ${nombre(cote.draw_odds, 2)}</span>` : ''}
        <span>2 · ${nombre(cote.away_odds, 2)}</span>
      </div>
      <div class="rangee-rapide">
        <input type="number" class="score-rapide" data-camp="home" min="0" max="199"
               inputmode="numeric" aria-label="Score ${echapper(m.home?.name)}">
        <span class="tiret">-</span>
        <input type="number" class="score-rapide" data-camp="away" min="0" max="199"
               inputmode="numeric" aria-label="Score ${echapper(m.away?.name)}">
        <span class="retour-rapide muet">${dejaParie ? `Parié : ${echapper(dejaParie)}` : ''}</span>
      </div>` : '<div class="muet">Cotes pas encore générées</div>'}
    </div>`;
}

function brancherParisRapides(conteneur, mise) {
  for (const carte of conteneur.querySelectorAll('.carte-match[data-match]')) {
    const champs = carte.querySelectorAll('.score-rapide');
    if (champs.length !== 2) continue;
    const retour = carte.querySelector('.retour-rapide');
    let minuteur = null;

    const lire = () => [...champs].map((c) => c.value.trim());

    const envoyer = async () => {
      clearTimeout(minuteur);
      const [ph, pa] = lire();
      if (ph === '' || pa === '') return;
      champs.forEach((c) => { c.disabled = true; });
      retour.textContent = 'Placement…';
      retour.className = 'retour-rapide muet';
      try {
        await placerPari(carte.dataset.match, Number(ph), Number(pa), mise);
        retour.textContent = `✓ ${ph}-${pa} pour ${nombre(mise)} ✦`;
        retour.className = 'retour-rapide succes';
        carte.dataset.parie = '1';
        champs.forEach((c) => { c.value = ''; });
        window.dispatchEvent(new Event('eclats-changes'));
      } catch (e) {
        retour.textContent = `Refusé : ${e.message}`;
        retour.className = 'retour-rapide erreur';
      } finally {
        champs.forEach((c) => { c.disabled = false; });
      }
    };

    const planifier = () => {
      clearTimeout(minuteur);
      const [ph, pa] = lire();
      if (ph === '' || pa === '') {
        retour.textContent = '';
        retour.className = 'retour-rapide muet';
        return;
      }
      retour.textContent = `Pari ${ph}-${pa} dans un instant…`;
      retour.className = 'retour-rapide muet';
      minuteur = setTimeout(envoyer, DELAI_ENVOI);
    };

    champs.forEach((c) => {
      c.addEventListener('input', planifier);
      // Entrée : envoi immédiat, sans attendre le délai
      c.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter') {
          evt.preventDefault();
          c.blur();
          envoyer();
        }
      });
    });
  }
}
