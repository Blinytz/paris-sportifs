import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
let echec = false;
function test(nom, condition) {
  console.log(`${condition ? "✓" : "✗"} ${nom}`);
  if (!condition) echec = true;
}

const schema = read("sql/schema.sql");
const install = read("sql/install_complet.sql");
const migration = read("sql/securite_administration.sql");
const paliers = read("sql/paliers_reglables.sql");
const brouillons = read("sql/brouillons.sql");
const correctifValidation = read("sql/correctif_validation_brouillons.sql");
const reservationImmediate = read("sql/reservation_immediate.sql");
const reglages = read("pwa/js/pages/reglages.js");
const api = read("pwa/js/api.js");
const accueil = read("pwa/js/pages/accueil.js");
const mesParis = read("pwa/js/pages/mes-paris.js");
const match = read("pwa/js/pages/match.js");
const saisie = read("pwa/js/saisie.js");
const settlement = read("scripts/settle_bets.py");
const {
  classeCasesPronostic, classeGainPari, etatTemporelMatch, matchOuvert,
} = await import("../pwa/js/etat-prono.js");

for (const [nom, sql] of [["schema", schema], ["installation complète", install]]) {
  test(`${nom} interdit l'insertion directe dans bets`,
    sql.includes("revoke insert on bets from authenticated") &&
    !sql.includes('create policy "bets_insert_own"'));
  test(`${nom} réserve les réglages à l'administrateur`,
    sql.includes('create policy "settings_update_admin"') &&
    sql.includes("is_app_admin()"));
}
test("la migration supprime explicitement l'ancienne policy vulnérable",
  migration.includes('drop policy if exists "bets_insert_own"'));
test("les paliers sont réservés à l'administrateur",
  paliers.includes('create policy "paliers_update_admin"') &&
  !paliers.includes("auth.role() = 'authenticated'"));
test("le barème de points n'est plus figé dans la fonction",
  install.includes("s.pp_par_pari") && install.includes("s.pp_score_exact"));
test("la page Réglages édite seuils et primes",
  reglages.includes("listePaliers") && reglages.includes("sauverPalier") &&
  reglages.includes("strictement croissants"));
test("le rôle serveur peut exécuter la validation des brouillons",
  brouillons.includes("grant execute on function validate_due_drafts() to service_role") &&
  correctifValidation.includes(
    "grant execute on function public.validate_due_drafts() to service_role"));
test("une erreur de validation fait échouer le règlement",
  settlement.includes('log.exception("Échec de la validation des brouillons")') &&
  settlement.includes("        raise"));
test("les écritures directes de brouillons sont remplacées par des RPC",
  reservationImmediate.includes(
    "revoke insert, update, delete on bet_drafts from authenticated") &&
  reservationImmediate.includes("create or replace function save_bet_draft(") &&
  reservationImmediate.includes("create or replace function delete_bet_draft(") &&
  api.includes("rpc('save_bet_draft'") &&
  api.includes("rpc('delete_bet_draft'"));
test("la mise est plafonnée au solde et la suppression rembourse",
  reservationImmediate.includes(
    "v_reserved := least(p_requested_stake, v_available_pool)") &&
  reservationImmediate.includes("'paris_sportifs_annulation'") &&
  reservationImmediate.includes("'refunded', v_refund"));
test("la validation ne débite pas une réservation une seconde fois",
  reservationImmediate.includes("-- Aucun débit ici : la mise est déjà réservée.") &&
  reservationImmediate.includes("if not v_draft.stake_reserved then"));
test("l'interface actualise le solde après réservation ou remboursement",
  saisie.includes("new Event('eclats-changes')") &&
  saisie.includes("solde disponible atteint") &&
  !mesParis.includes("Il te manque"));

function reservationModele(demandee, solde, ancienne = 0, dejaReservee = false) {
  const disponible = Math.max(solde, 0) + (dejaReservee ? ancienne : 0);
  const reservee = Math.min(demandee, disponible);
  const delta = dejaReservee ? ancienne - reservee : -reservee;
  return { reservee, delta, soldeApres: solde + delta };
}
test("100 demandés avec 50 disponibles réserve exactement 50",
  JSON.stringify(reservationModele(100, 50)) ===
    JSON.stringify({ reservee: 50, delta: -50, soldeApres: 0 }));
test("réduire ou augmenter une réservation ne porte que sur la différence",
  reservationModele(30, 0, 50, true).delta === 20 &&
  reservationModele(100, 20, 30, true).reservee === 50 &&
  reservationModele(100, 20, 30, true).delta === -20);

const maintenant = Date.parse("2026-07-24T18:00:00Z");
const futur = { status: "scheduled", kickoff_at: "2026-07-24T19:00:00Z" };
const passeEncorePlanifie = {
  status: "scheduled", kickoff_at: "2026-07-24T17:00:00Z",
};
test("un match futur et planifié reste modifiable",
  matchOuvert(futur, maintenant) &&
  etatTemporelMatch(futur, maintenant) === "a-venir");
test("l'heure verrouille un match même si le statut scheduled est en retard",
  !matchOuvert(passeEncorePlanifie, maintenant) &&
  etatTemporelMatch(passeEncorePlanifie, maintenant) === "verrouille");
test("les cases distinguent enregistré, verrouillé, gagné, perdu et annulé",
  classeCasesPronostic(futur, null, { id: "b" }, maintenant) === "enregistre" &&
  classeCasesPronostic(passeEncorePlanifie, null, { id: "b" }, maintenant) === "verrouille" &&
  classeCasesPronostic(passeEncorePlanifie, { status: "won" }, null, maintenant) === "gagne" &&
  classeCasesPronostic(passeEncorePlanifie, { status: "lost" }, null, maintenant) === "perdu" &&
  classeCasesPronostic(passeEncorePlanifie, { status: "void" }, null, maintenant) === "annule");
test("le rectangle de résultat suit gagné, perdu, annulé ou en jeu",
  classeGainPari({ status: "won" }) === "gagne" &&
  classeGainPari({ status: "lost" }) === "perdu" &&
  classeGainPari({ status: "void" }) === "annule" &&
  classeGainPari({ status: "pending" }) === "en-jeu");
test("les filtres rapides affichent le nom brut avec le drapeau",
  accueil.includes("${embleme(l)} ${echapper(l.name)}") &&
  !accueil.includes("${embleme(l)} ${echapper(nomLigue(l))}</button>"));
test("Mes paris sépare les brouillons verrouillés des modifiables",
  mesParis.includes("const modifiables =") &&
  mesParis.includes("const enAttenteValidation =") &&
  mesParis.includes("matchOuvert(d.match)"));
test("le score réel et le pronostic sont libellés sans ambiguïté",
  accueil.includes("'Score final'") &&
  accueil.includes("Mon pronostic · pari validé") &&
  mesParis.includes("Mon pronostic <strong>") &&
  match.includes("Mon pronostic enregistré"));

const jsDirs = ["pwa/js", "pwa/js/pages"];
for (const dir of jsDirs) {
  for (const fichier of readdirSync(new URL(`${dir}/`, root)).filter((f) => f.endsWith(".js"))) {
    const chemin = `${dir}/${fichier}`;
    const resultat = spawnSync(process.execPath, ["--check", chemin], {
      cwd: new URL(".", root), encoding: "utf8"
    });
    test(`syntaxe valide : ${chemin}`, resultat.status === 0);
  }
}

if (echec) throw new Error("Une ou plusieurs vérifications ont échoué.");
