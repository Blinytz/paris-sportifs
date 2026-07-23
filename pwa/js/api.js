// Requêtes métier vers Supabase (lecture des données sportives, paris,
// solde d'Éclats, réglages du modèle).

import { effacer, patch, rest, rpc, upsert, utilisateur } from './supabase.js';

// Embeds PostgREST réutilisés : les deux FK équipes de `matches` doivent
// être désambiguïsées par le nom de contrainte.
const EMBED_MATCH = '*,league:leagues(*),home:teams!matches_home_team_id_fkey(*),away:teams!matches_away_team_id_fkey(*)';

// Matchs d'une journée (bornes locales), tous statuts, pour le sélecteur
// de dates de la page Paris.
export function matchsDuJour(dateLocale, { sport, leagueId } = {}) {
  const debut = new Date(`${dateLocale}T00:00:00`);
  const fin = new Date(debut.getTime() + 86400000);
  const params = {
    select: EMBED_MATCH,
    and: `(kickoff_at.gte.${debut.toISOString()},kickoff_at.lt.${fin.toISOString()})`,
    order: 'kickoff_at.asc',
    limit: '200',
  };
  if (leagueId) params.league_id = `eq.${leagueId}`;
  if (sport) {
    params.select = params.select.replace('league:leagues(*)', 'league:leagues!inner(*)');
    params['league.sport'] = `eq.${sport}`;
  }
  return rest('matches', params);
}

// ---------- Brouillons de pronostic ----------
// Un score saisi est enregistré aussitôt, mais le pari n'est validé (et
// la mise débitée) qu'au coup d'envoi, par la fonction serveur
// validate_due_drafts. Tant que le match n'a pas commencé, le brouillon
// reste modifiable depuis n'importe quelle page.

export async function brouillonsSurMatchs(matchIds) {
  if (!matchIds.length) return new Map();
  const rows = await rest('bet_drafts', {
    match_id: `in.(${matchIds.join(',')})`,
  });
  return new Map(rows.map((d) => [d.match_id, d]));
}

export async function lireBrouillon(matchId) {
  const rows = await rest('bet_drafts', { match_id: `eq.${matchId}` });
  return rows[0] || null;
}

export function tousLesBrouillons() {
  return rest('bet_drafts', {
    select: `*,match:matches(${EMBED_MATCH})`,
    order: 'updated_at.desc',
  });
}

// Enregistre (ou met à jour) le pronostic. La RLS refuse l'écriture dès
// que le match a commencé : le score est alors figé.
export function enregistrerBrouillon(matchId, home, away, mise) {
  return upsert('bet_drafts', {
    user_id: utilisateur()?.id,
    match_id: matchId,
    predicted_home: home,
    predicted_away: away,
    stake_eclats: mise,
    updated_at: new Date().toISOString(),
  }, 'user_id,match_id');
}

export function supprimerBrouillon(matchId) {
  return effacer('bet_drafts', { match_id: `eq.${matchId}` });
}

// Paris réglés en attente de collecte (gains et remboursements)
export function parisACollecter() {
  return rest('bets', {
    status: 'in.(won,void)',
    collected_at: 'is.null',
    select: `*,match:matches(${EMBED_MATCH})`,
    order: 'resolved_at.desc',
  });
}

// Collecte : sans argument, récolte tout ; sinon les paris désignés.
// Retourne le total crédité (calculé côté serveur).
export function collecter(betIds) {
  return rpc('collect_winnings', betIds ? { p_bet_ids: betIds } : {});
}

export function listeLigues() {
  return rest('leagues', { active: 'is.true', order: 'sport.asc,category.asc,name.asc' });
}

export function prochainsMatchs({ sport, leagueId } = {}) {
  const params = {
    status: 'eq.scheduled',
    odds_locked: 'is.false',
    kickoff_at: `gte.${new Date().toISOString()}`,
    select: EMBED_MATCH,
    order: 'kickoff_at.asc',
    limit: '200',
  };
  if (leagueId) params.league_id = `eq.${leagueId}`;
  if (sport) {
    params.select = params.select.replace('league:leagues(*)', 'league:leagues!inner(*)');
    params['league.sport'] = `eq.${sport}`;
  }
  return rest('matches', params);
}

export async function lireMatch(id) {
  const rows = await rest('matches', { id: `eq.${id}`, select: EMBED_MATCH });
  return rows[0] || null;
}

// Dernière cote générée pour une liste de matchs -> Map match_id -> ligne.
// Si `avant` est fourni (ISO), prend la dernière cote générée avant cette
// date (vue "avant-match" d'un match terminé, section 7.3).
export async function dernieresCotes(matchIds, avant) {
  if (!matchIds.length) return new Map();
  const params = {
    match_id: `in.(${matchIds.join(',')})`,
    order: 'generated_at.desc',
  };
  if (avant) params.generated_at = `lt.${avant}`;
  const rows = await rest('odds_generated', params);
  const parMatch = new Map();
  for (const row of rows) {
    if (!parMatch.has(row.match_id)) parMatch.set(row.match_id, row);
  }
  return parMatch;
}

export async function lireEquipe(id) {
  const rows = await rest('teams', { id: `eq.${id}` });
  return rows[0] || null;
}

export async function statsGlobales(teamId) {
  const rows = await rest('team_global_stats', { team_id: `eq.${teamId}` });
  return rows[0] || null;
}

export function statsParCompetition(teamId) {
  return rest('team_competition_stats', {
    team_id: `eq.${teamId}`,
    select: '*,league:leagues(*)',
    order: 'matches_played.desc',
  });
}

export async function statsCompetition(teamId, leagueId) {
  const rows = await rest('team_competition_stats', {
    team_id: `eq.${teamId}`, league_id: `eq.${leagueId}`,
  });
  return rows[0] || null;
}

// Matchs d'une équipe. Options : statut, camp ('home'/'away'), avant
// (kickoff_at < date ISO — pour les stats "avant-match"), limite.
export function matchsEquipe(teamId, { statut, camp, avant, limite = 20 } = {}) {
  const params = {
    select: EMBED_MATCH,
    order: statut === 'scheduled' ? 'kickoff_at.asc' : 'kickoff_at.desc',
    limit: String(limite),
  };
  if (camp === 'home') params.home_team_id = `eq.${teamId}`;
  else if (camp === 'away') params.away_team_id = `eq.${teamId}`;
  else params.or = `(home_team_id.eq.${teamId},away_team_id.eq.${teamId})`;
  if (statut) params.status = `eq.${statut}`;
  if (avant) params.kickoff_at = `lt.${avant}`;
  return rest('matches', params);
}

// Confrontations directes (section 7.2 point 4), tous sens confondus.
export function confrontations(equipeA, equipeB) {
  return rest('matches', {
    status: 'eq.finished',
    or: `(and(home_team_id.eq.${equipeA},away_team_id.eq.${equipeB}),and(home_team_id.eq.${equipeB},away_team_id.eq.${equipeA}))`,
    select: EMBED_MATCH,
    order: 'kickoff_at.desc',
  });
}

export function mesParis() {
  return rest('bets', {
    select: `*,match:matches(${EMBED_MATCH})`,
    order: 'placed_at.desc',
  });
}

export function mesParisSurMatch(matchId) {
  return rest('bets', { match_id: `eq.${matchId}`, order: 'placed_at.desc' });
}

// Paris en cours sur une liste de matchs -> Map match_id -> [paris]
export async function mesParisSurMatchs(matchIds) {
  if (!matchIds.length) return new Map();
  const rows = await rest('bets', {
    match_id: `in.(${matchIds.join(',')})`,
    order: 'placed_at.desc',
  });
  const parMatch = new Map();
  for (const b of rows) {
    if (!parMatch.has(b.match_id)) parMatch.set(b.match_id, []);
    parMatch.get(b.match_id).push(b);
  }
  return parMatch;
}

// Règle 8 : le placement passe par la fonction SQL place_bet (atomique,
// vérifie solde + verrouillage côté serveur). On parie un SCORE ; l'issue
// et la cote appliquée sont dérivées côté serveur.
export function placerPari(matchId, home, away, mise) {
  return rpc('place_bet', {
    p_match_id: matchId, p_home: home, p_away: away, p_stake: mise,
  });
}

// Tous les mouvements du portefeuille, pour la courbe d'évolution
export function mouvementsLedger() {
  return rest('eclats_ledger', {
    select: 'amount,source,created_at',
    order: 'created_at.asc',
  });
}

// Solde = somme de toutes les entrées du ledger de l'utilisateur (règle 8).
export async function soldeEclats() {
  if (!utilisateur()) return 0;
  const rows = await rest('eclats_ledger', { select: 'amount' });
  return rows.reduce((total, r) => total + Number(r.amount), 0);
}

export async function lireLigue(id) {
  const rows = await rest('leagues', { id: `eq.${id}` });
  return rows[0] || null;
}

// Classement complet d'une ligue (dernière saison synchronisée),
// trié par groupe puis position.
export async function classementLigue(leagueId) {
  const rows = await rest('standings', {
    league_id: `eq.${leagueId}`,
    select: '*,team:teams(id,name)',
    order: 'season.desc,group_name.asc.nullsfirst,position.asc',
  });
  // Ne garder que la saison la plus récente présente en base
  const saison = rows[0]?.season;
  return rows.filter((r) => r.season === saison);
}

// Positions d'une équipe dans tous ses championnats -> lignes standings
// avec la ligue jointe (pour la page équipe).
export function positionsEquipe(teamId) {
  return rest('standings', {
    team_id: `eq.${teamId}`,
    select: '*,league:leagues(id,name,category)',
    order: 'season.desc',
  });
}

// Positions de plusieurs équipes dans une ligue donnée (page match)
// -> Map team_id -> ligne standings.
export async function positionsDansLigue(leagueId, teamIds) {
  if (!teamIds.length) return new Map();
  const rows = await rest('standings', {
    league_id: `eq.${leagueId}`,
    team_id: `in.(${teamIds.join(',')})`,
    order: 'season.desc',
  });
  const parEquipe = new Map();
  for (const row of rows) {
    if (!parEquipe.has(row.team_id)) parEquipe.set(row.team_id, row);
  }
  return parEquipe;
}

export async function lireReglages() {
  const rows = await rest('model_settings', { id: 'eq.default' });
  return rows[0] || null;
}

export function sauverReglages(valeurs) {
  return patch('model_settings', { id: 'eq.default' },
    { ...valeurs, updated_at: new Date().toISOString() });
}
