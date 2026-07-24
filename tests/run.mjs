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
const reglages = read("pwa/js/pages/reglages.js");
const accueil = read("pwa/js/pages/accueil.js");
const mesParis = read("pwa/js/pages/mes-paris.js");
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
