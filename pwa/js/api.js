// Requêtes métier vers Supabase (lecture des données sportives, paris,
// solde d'Éclats, réglages du modèle).

import { rest, patch, rpc, utilisateur } from './supabase.js';

// Embeds PostgREST réutilisés : les deux FK équipes de `matches` doivent
// être désambiguïsées par le nom de contrainte.
const EMBED_MATCH = '*,league:leagues(*),home:teams!matches_home_team_id_fkey(*),away:teams!matches_away_team_id_fkey(*)';

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

// Règle 8 : le placement passe par la fonction SQL place_bet (atomique,
// vérifie solde + verrouillage côté serveur).
export function placerPari(matchId, selection, mise) {
  return rpc('place_bet', {
    p_match_id: matchId, p_selection: selection, p_stake: mise,
  });
}

// Solde = somme de toutes les entrées du ledger de l'utilisateur (règle 8).
export async function soldeEclats() {
  if (!utilisateur()) return 0;
  const rows = await rest('eclats_ledger', { select: 'amount' });
  return rows.reduce((total, r) => total + Number(r.amount), 0);
}

export async function lireReglages() {
  const rows = await rest('model_settings', { id: 'eq.default' });
  return rows[0] || null;
}

export function sauverReglages(valeurs) {
  return patch('model_settings', { id: 'eq.default' },
    { ...valeurs, updated_at: new Date().toISOString() });
}
