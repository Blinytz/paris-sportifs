// Mes paris : bandeau « à récolter » en haut (avec Tout récolter), puis
// les paris en cours, puis l'historique déjà encaissé.
// Rien ne rejoint le portefeuille sans une action ici (ou sur la page
// d'un match) : c'est la collecte manuelle.

import {
  collecter, mesParis, soldeEclats, supprimerBrouillon, tousLesBrouillons,
} from '../api.js';
import {
  classeCasesPronostic, classeGainPari, etatTemporelMatch, matchOuvert,
} from '../etat-prono.js';
import { embleme, nomLigue } from '../ordre-ligues.js';
import {
  blason, dateHeure, echapper, eclats, envoyerPieces, erreur, gainPari,
  libelleBonus, squelettes, toast, vide,
} from '../ui.js';

const LIBELLES = {
  pending: 'en cours', won: 'gagné', lost: 'perdu', void: 'remboursé',
};

export async function pageMesParis(conteneur) {
  conteneur.innerHTML = squelettes(4);
  try {
    const [paris, brouillons, solde] = await Promise.all([
      mesParis(), tousLesBrouillons(), soldeEclats(),
    ]);
    rendre(conteneur, paris, brouillons, solde);
  } catch (e) {
    conteneur.innerHTML = erreur(e);
  }
}

function montantACollecter(p) {
  return p.status === 'won' ? gainPari(p) : Number(p.stake_eclats);
}

// Plus le gain est gros, plus il y a de pièces (dans des bornes lisibles)
function nbPieces(montant) {
  return Math.max(4, Math.min(12, Math.round(montant / 90) + 4));
}

function rendre(conteneur, paris, brouillons = [], solde = 0) {
  const aCollecter = paris.filter(
    (p) => !p.collected_at && (p.status === 'won' || p.status === 'void'));
  // L'heure du coup d'envoi prime sur un statut sportif éventuellement
  // en retard : un pari passé ne retourne jamais parmi les paris à venir.
  const enDirect = paris.filter((p) => p.status === 'pending'
    && etatTemporelMatch(p.match) !== 'a-venir');
  const enAttente = paris.filter(
    (p) => p.status === 'pending' && etatTemporelMatch(p.match) === 'a-venir');
  const historique = paris.filter(
    (p) => p.status === 'lost' || p.collected_at);

  if (!paris.length && !brouillons.length) {
    conteneur.innerHTML = `<h1>Mes paris</h1>${vide('🎟️', 'Aucun pronostic pour le moment',
      'Saisis un score depuis l\'onglet Paris pour te lancer.')}`;
    return;
  }


  // Brouillons à venir vs brouillons rejetés au coup d'envoi
  const brouillonsActifs = brouillons.filter((d) => !d.rejected_at);
  const modifiables = brouillonsActifs.filter((d) => matchOuvert(d.match));
  const enAttenteValidation = brouillonsActifs.filter((d) => !matchOuvert(d.match));
  const rejetes = brouillons.filter((d) => d.rejected_at);
  const engage = brouillonsActifs.reduce(
    (s, d) => s + Number(d.stake_eclats), 0);
  const manque = engage - solde;

  conteneur.innerHTML = `
    <h1>Mes paris</h1>
    ${brouillonsActifs.length
      ? bandeauEngagement(engage, solde, manque, aCollecter.length > 0) : ''}
    ${aCollecter.length ? `
      <div class="bandeau-collecte" id="bandeau-collecte">
        <div class="details">
          <div class="montant">✦ ${aCollecter.length} gain${aCollecter.length > 1 ? 's' : ''}
            à récolter</div>
          <div class="sous">D'un seul coup, ou match par match plus bas.</div>
        </div>
        <button class="btn-or" id="tout-collecter">Tout récolter</button>
      </div>
      ${aCollecter.map((p) => cartePari(p, true)).join('')}` : ''}

    ${enDirect.length ? `<h2>🔒 En cours ou en règlement (${enDirect.length})</h2>
      <p class="faible">Ces paris ne sont plus modifiables. Le statut et le
        score sont rafraîchis à chaque synchronisation.</p>
      ${enDirect.map((p) => cartePari(p)).join('')}` : ''}

    ${enAttente.length ? `<h2>Paris validés (${enAttente.length})</h2>
      ${enAttente.map((p) => cartePari(p)).join('')}` : ''}

    ${rejetes.length ? `<h2>Non validés (${rejetes.length})</h2>
      <p class="faible">Ces pronostics n'ont pas pu devenir des paris au
        coup d'envoi. Aucun Éclat n'a été engagé.</p>
      ${rejetes.map(carteBrouillon).join('')}` : ''}

    ${enAttenteValidation.length ? `<h2>Validation en cours (${enAttenteValidation.length})</h2>
      <p class="faible">Le coup d’envoi est passé : les scores sont verrouillés
        et seront transformés en paris lors du prochain passage serveur.</p>
      ${enAttenteValidation.map(carteBrouillon).join('')}` : ''}

    ${modifiables.length ? `<h2>Pronostics enregistrés (${modifiables.length})</h2>
      ${modifiables.map(carteBrouillon).join('')}` : ''}

    ${historique.length ? `<h2>Historique</h2>
      ${historique.slice(0, 40).map((p) => cartePari(p)).join('')}` : ''}`;

  brancherCollecte(conteneur, aCollecter);
}

// Prévient AVANT le coup d'envoi si les mises engagées dépassent le
// solde : sans cela, les paris seraient refusés un par un sans que
// l'utilisateur puisse réagir.
function bandeauEngagement(engage, solde, manque, aRecolter) {
  if (manque <= 0) {
    return `<p class="faible centre">${eclats(engage)} ✦ prévus sur tes
      pronostics non encore débités, pour ${eclats(solde)} ✦ disponibles.</p>`;
  }
  return `
    <div class="bandeau-alerte">
      <div>
        <strong>Il te manque ${eclats(manque)} ✦</strong>
        <div class="sous">Tu as prévu ${eclats(engage)} ✦ sur tes pronostics
          non encore débités mais ne possèdes que ${eclats(solde)} ✦.
          À leur validation, les derniers seront refusés faute de solde.</div>
        ${aRecolter ? `<div class="sous"><strong>Récolte tes gains en
          attente ci-dessus</strong> : ils ne comptent dans ton solde
          qu'une fois encaissés.</div>` : ''}
      </div>
    </div>`;
}

// Pronostic enregistré (ou rejeté au coup d'envoi)
function carteBrouillon(d) {
  const m = d.match;
  const modifiable = !d.rejected_at && matchOuvert(m);
  const classeCases = classeCasesPronostic(m, null, d);
  if (d.rejected_at) {
    return `
      <div class="carte" data-brouillon="${d.id}">
        <div class="match-entete">
          <a class="competition" href="#/match/${d.match_id}">
            ${embleme(m?.league)} ${echapper(nomLigue(m?.league))}
          </a>
          <span>${dateHeure(m?.kickoff_at)}</span>
        </div>
        <div class="match-corps">
          <div class="equipe">${blason(m?.home)}
            <span class="nom">${echapper(m?.home?.name)}</span></div>
          <div class="bloc-score">
            <div class="cases-score">
              <div class="score-fige annule">${d.predicted_home}</div>
              <span class="deux-points">:</span>
              <div class="score-fige annule">${d.predicted_away}</div>
            </div>
          </div>
          <div class="equipe">${blason(m?.away)}
            <span class="nom">${echapper(m?.away?.name)}</span></div>
        </div>
        <div class="match-pied">
          <span class="erreur">${echapper(d.rejected_reason || 'Non validé')}</span>
          <button class="btn-fantome bouton-oublier"
            data-match="${d.match_id}">Effacer</button>
        </div>
      </div>`;
  }
  return `
    <a class="carte" href="#/match/${d.match_id}">
      <div class="match-entete">
        <span class="competition">
          ${embleme(m?.league)} ${echapper(nomLigue(m?.league))}
        </span>
        <span>${dateHeure(m?.kickoff_at)}</span>
      </div>
      <div class="match-corps">
        <div class="equipe">${blason(m?.home)}
          <span class="nom">${echapper(m?.home?.name)}</span></div>
        <div class="bloc-score">
          <div class="cases-score">
            <div class="score-fige ${classeCases}">${d.predicted_home}</div>
            <span class="deux-points">:</span>
            <div class="score-fige ${classeCases}">${d.predicted_away}</div>
          </div>
        </div>
        <div class="equipe">${blason(m?.away)}
          <span class="nom">${echapper(m?.away?.name)}</span></div>
      </div>
      <div class="match-pied">
        <span class="libelle">Mise prévue ${eclats(d.stake_eclats)} ✦</span>
        <span class="gain-pastille ${modifiable ? 'enregistre' : 'en-jeu'}">
          ${modifiable ? 'modifiable' : '🔒 verrouillé'}</span>
      </div>
    </a>`;
}

function cartePari(p, recoltable = false) {
  const m = p.match;
  const termine = m?.status === 'finished';
  const enDirect = etatTemporelMatch(m) === 'en-cours'
    || etatTemporelMatch(m) === 'verrouille';
  const classeCases = classeCasesPronostic(m, p);
  const classeGain = classeGainPari(p);
  const montant = montantACollecter(p);
  return `
    <div class="carte" data-pari="${p.id}">
      <div class="match-entete">
        <a class="competition" href="#/match/${p.match_id}">
          ${embleme(m?.league)} ${echapper(nomLigue(m?.league))}
        </a>
        <span>${dateHeure(m?.kickoff_at)}</span>
      </div>
      <div class="match-corps">
        <a class="equipe" href="#/equipe/${m?.home_team_id}">
          ${blason(m?.home)}<span class="nom">${echapper(m?.home?.name)}</span>
        </a>
        <div class="bloc-score">
          <div class="cases-score">
            <div class="score-fige ${classeCases}">${termine || enDirect ? m.score_home ?? '?' : '?'}</div>
            <span class="deux-points">:</span>
            <div class="score-fige ${classeCases}">${termine || enDirect ? m.score_away ?? '?' : '?'}</div>
          </div>
          <div class="faible">pronostic ${p.predicted_home} - ${p.predicted_away}</div>
        </div>
        <a class="equipe" href="#/equipe/${m?.away_team_id}">
          ${blason(m?.away)}<span class="nom">${echapper(m?.away?.name)}</span>
        </a>
      </div>
      <div class="match-pied resultat-${classeGain}">
        <div>
          <div class="libelle">${eclats(p.stake_eclats)} ✦ à ${echapper(Number(p.odds_at_bet).toFixed(2))}
            · ${LIBELLES[p.status] || echapper(p.status)}</div>
          <div class="valeur">
            ${p.status === 'won'
              ? `+${eclats(gainPari(p))} ✦ <span class="faible">${echapper(libelleBonus(p, m?.score_home, m?.score_away))}</span>`
              : p.status === 'lost' ? `<span class="erreur">−${eclats(p.stake_eclats)} ✦</span>`
              : p.status === 'void' ? `${eclats(p.stake_eclats)} ✦ rendus`
              : `gain possible ${eclats(p.potential_payout)} ✦`}
          </div>
        </div>
        ${recoltable
          ? `<button class="btn-or bouton-recolter" data-pari="${p.id}"
               data-montant="${montant}">Récolter</button>`
          : ''}
      </div>
    </div>`;
}

function brancherCollecte(conteneur, aCollecter) {
  const rafraichir = async () => {
    try {
      const [paris, brouillons, solde] = await Promise.all([
        mesParis(), tousLesBrouillons(), soldeEclats(),
      ]);
      rendre(conteneur, paris, brouillons, solde);
    } catch (e) {
      conteneur.innerHTML = erreur(e);
    }
  };

  // Effacer un pronostic non validé
  conteneur.querySelectorAll('.bouton-oublier').forEach((bouton) => {
    bouton.addEventListener('click', async () => {
      bouton.disabled = true;
      try {
        await supprimerBrouillon(bouton.dataset.match);
        rafraichir();
      } catch (e) {
        bouton.disabled = false;
        toast(e.message, 'echec');
      }
    });
  });

  // Récolte unitaire
  conteneur.querySelectorAll('.bouton-recolter').forEach((bouton) => {
    bouton.addEventListener('click', async () => {
      const carte = bouton.closest('.carte');
      bouton.disabled = true;
      bouton.textContent = '…';
      try {
        await collecter([bouton.dataset.pari]);
        envoyerPieces(carte, nbPieces(Number(bouton.dataset.montant)));
        carte.classList.add('collectee');
        window.dispatchEvent(new Event('eclats-collectes'));
        setTimeout(rafraichir, 900);
      } catch (e) {
        bouton.disabled = false;
        bouton.textContent = 'Récolter';
        toast(e.message, 'echec');
      }
    });
  });

  // Tout récolter : les cartes partent en cascade
  const tout = conteneur.querySelector('#tout-collecter');
  if (!tout) return;
  tout.addEventListener('click', async () => {
    tout.disabled = true;
    tout.textContent = 'Récolte…';
    const bandeau = conteneur.querySelector('#bandeau-collecte');
    try {
      const total = await collecter(null);
      // Cascade : une volée de pièces par carte, décalée dans le temps
      const cartes = aCollecter.map(
        (p) => conteneur.querySelector(`.carte[data-pari="${p.id}"]`));
      cartes.forEach((carte, i) => {
        if (!carte) return;
        setTimeout(() => {
          envoyerPieces(carte, 4);
          carte.classList.add('collectee');
        }, i * 90);
      });
      // Un seul événement : le compteur ne roule qu'une fois, vers le total
      window.dispatchEvent(new Event('eclats-collectes'));
      toast(`+${eclats(total)} ✦ récoltés`, 'succes');
      if (bandeau) bandeau.classList.add('collectee');
      setTimeout(rafraichir, 1100 + cartes.length * 90);
    } catch (e) {
      tout.disabled = false;
      tout.textContent = 'Tout récolter';
      toast(e.message, 'echec');
    }
  });
}
