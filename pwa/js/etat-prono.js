// Source de vérité commune pour l'état temporel d'un match et l'aspect
// d'un pronostic. Le statut fourni par l'API sportive peut arriver après
// le coup d'envoi : l'heure verrouille donc toujours la saisie, même si
// le match est encore marqué "scheduled" en base.

const horodatage = (valeur) => {
  const resultat = Date.parse(valeur);
  return Number.isFinite(resultat) ? resultat : null;
};

export function matchOuvert(match, maintenant = Date.now()) {
  const debut = horodatage(match?.kickoff_at);
  return match?.status === 'scheduled'
    && debut !== null
    && debut > Number(maintenant);
}

export function etatTemporelMatch(match, maintenant = Date.now()) {
  if (match?.status === 'finished') return 'termine';
  if (match?.status === 'cancelled') return 'annule';
  if (match?.status === 'postponed') return 'reporte';
  if (match?.status === 'live') return 'en-cours';
  if (matchOuvert(match, maintenant)) return 'a-venir';

  // Coup d'envoi passé mais statut sportif pas encore rafraîchi :
  // on sait que la saisie est fermée, pas que le match a réellement débuté.
  return 'verrouille';
}

export function classeCasesPronostic(match, pari, brouillon, maintenant = Date.now()) {
  if (pari?.status === 'won') return 'gagne';
  if (pari?.status === 'lost') return 'perdu';
  if (pari?.status === 'void') return 'annule';

  const etatMatch = etatTemporelMatch(match, maintenant);
  if (etatMatch === 'termine') return pari ? 'verrouille' : 'joue';
  if (etatMatch === 'annule' || etatMatch === 'reporte') return 'annule';
  if (etatMatch === 'en-cours' || etatMatch === 'verrouille' || pari) {
    return 'verrouille';
  }
  return brouillon ? 'enregistre' : 'vide';
}

export function classeGainPari(pari) {
  if (pari?.status === 'won') return 'gagne';
  if (pari?.status === 'lost') return 'perdu';
  if (pari?.status === 'void') return 'annule';
  return 'en-jeu';
}
