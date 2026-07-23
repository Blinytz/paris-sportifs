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
