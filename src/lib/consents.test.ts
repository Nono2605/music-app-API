import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MIN_AGE,
  agePurpose,
  latestByPurpose,
  parseConsentInput,
  parsePrivacyConfig,
  privacyState,
  rowsToInsert,
  type ConsentRecord,
  type PrivacyConfig,
} from "./consents";

const config: PrivacyConfig = { minAge: 16, optionalPurposes: ["ads_personalization"] };
const V1 = "2026-10";
const V2 = "2026-11";
const row = (purpose: string, granted: boolean, version: string, at: string): ConsentRecord => ({
  purpose,
  granted,
  policy_version: version,
  created_at: at,
});
const t = (n: number) => `2026-10-11T10:0${n}:00.000Z`;

describe("parsePrivacyConfig", () => {
  it("valeurs par défaut : 16 ans, aucune finalité facultative", () => {
    assert.deepEqual(parsePrivacyConfig(undefined, undefined), { minAge: 16, optionalPurposes: [] });
    assert.equal(DEFAULT_MIN_AGE, 16);
  });

  it("âge valide entre 13 et 18, sinon 16", () => {
    assert.equal(parsePrivacyConfig("13", "").minAge, 13);
    assert.equal(parsePrivacyConfig("18", "").minAge, 18);
    for (const bad of ["12", "19", "abc", ""]) assert.equal(parsePrivacyConfig(bad, "").minAge, 16, bad);
  });

  it("finalités facultatives : seules les connues, sans doublon", () => {
    assert.deepEqual(parsePrivacyConfig("16", " ads_personalization , analytics, ads_personalization, hack ").optionalPurposes, [
      "ads_personalization",
      "analytics",
    ]);
  });

  it("la finalité d'âge porte le seuil", () => {
    assert.equal(agePurpose(16), "age_16");
    assert.equal(agePurpose(18), "age_18");
  });
});

describe("latestByPurpose", () => {
  it("garde la décision la plus récente de chaque finalité, quel que soit l'ordre", () => {
    const rows = [row("ads_personalization", false, V1, t(5)), row("ads_personalization", true, V1, t(1)), row("terms", true, V1, t(2))];
    const latest = latestByPurpose(rows);
    assert.equal(latest.get("ads_personalization")?.granted, false);
    assert.equal(latest.get("terms")?.granted, true);
  });

  it("à date égale, la dernière de la liste gagne", () => {
    const rows = [row("analytics", true, V1, t(1)), row("analytics", false, V1, t(1))];
    assert.equal(latestByPurpose(rows).get("analytics")?.granted, false);
  });
});

describe("privacyState", () => {
  it("compte neuf : il faut tout accepter", () => {
    const state = privacyState([], V1, config);
    assert.equal(state.needs_acceptance, true);
    assert.equal(state.terms_accepted_at, null);
    assert.equal(state.age_confirmed, false);
    assert.deepEqual(state.choices, [{ purpose: "ads_personalization", granted: null }]);
  });

  it("conditions + âge pour la version actuelle : rien à demander", () => {
    const state = privacyState([row("age_16", true, V1, t(1)), row("terms", true, V1, t(2))], V1, config);
    assert.equal(state.needs_acceptance, false);
    assert.equal(state.terms_accepted_at, t(2));
  });

  it("nouveau texte : les conditions se redemandent, pas l'âge", () => {
    const state = privacyState([row("age_16", true, V1, t(1)), row("terms", true, V1, t(2))], V2, config);
    assert.equal(state.needs_acceptance, true);
    assert.equal(state.terms_accepted_at, null);
    assert.equal(state.age_confirmed, true);
  });

  it("un seuil d'âge relevé redemande l'âge (nouvelle finalité)", () => {
    const rows = [row("age_16", true, V1, t(1)), row("terms", true, V1, t(2))];
    assert.equal(privacyState(rows, V1, { ...config, minAge: 18 }).needs_acceptance, true);
  });

  it("les conditions refusées ne comptent pas", () => {
    const state = privacyState([row("age_16", true, V1, t(1)), row("terms", false, V1, t(2))], V1, config);
    assert.equal(state.needs_acceptance, true);
  });

  it("le dernier choix facultatif est celui qui compte", () => {
    const rows = [row("ads_personalization", true, V1, t(1)), row("ads_personalization", false, V1, t(3))];
    assert.deepEqual(privacyState(rows, V1, config).choices, [{ purpose: "ads_personalization", granted: false }]);
  });
});

describe("parseConsentInput", () => {
  const ok = (body: unknown) => parseConsentInput(body, config);

  it("une acceptation complète", () => {
    const parsed = ok({ policy_version: V1, accept_terms: true, age_attested: true, source: "welcome" });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.input.acceptTerms, true);
      assert.equal(parsed.input.ageAttested, true);
      assert.equal(parsed.input.source, "welcome");
    }
  });

  it("une origine inconnue devient « api »", () => {
    const parsed = ok({ policy_version: V1, accept_terms: true, age_attested: true, source: "<script>" });
    assert.equal(parsed.ok && parsed.input.source, "api");
  });

  it("refuse un corps ou une version invalide", () => {
    for (const body of [null, [], "x", {}, { policy_version: "" }, { policy_version: "a b" }, { policy_version: "x".repeat(41), accept_terms: true }, { policy_version: 5, accept_terms: true }]) {
      assert.equal(ok(body).ok, false, JSON.stringify(body));
    }
  });

  it("on ne retire pas les conditions ni l'âge par cette route", () => {
    assert.equal(ok({ policy_version: V1, accept_terms: false }).ok, false);
    assert.equal(ok({ policy_version: V1, age_attested: false }).ok, false);
    assert.equal(ok({ policy_version: V1, accept_terms: "true" }).ok, false);
  });

  it("choix : seulement les finalités activées, et des booléens", () => {
    assert.equal(ok({ policy_version: V1, choices: { ads_personalization: false } }).ok, true);
    assert.equal(ok({ policy_version: V1, choices: { analytics: true } }).ok, false); // connue mais pas activée
    assert.equal(ok({ policy_version: V1, choices: { hack: true } }).ok, false);
    assert.equal(ok({ policy_version: V1, choices: { ads_personalization: "yes" } }).ok, false);
    assert.equal(ok({ policy_version: V1, choices: [true] }).ok, false);
  });

  it("une demande vide est refusée", () => {
    assert.equal(ok({ policy_version: V1 }).ok, false);
    assert.equal(ok({ policy_version: V1, choices: {} }).ok, false);
  });

  it("le message d'erreur ne reprend pas ce que le client a envoyé", () => {
    const parsed = ok({ policy_version: V1, choices: { "<img src=x onerror=alert(1)>": true } });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.ok(!parsed.error.includes("<img"));
  });
});

describe("rowsToInsert", () => {
  const input = (overrides: Partial<Parameters<typeof rowsToInsert>[1]> = {}) => ({
    version: V1,
    acceptTerms: true,
    ageAttested: true,
    choices: {},
    source: "welcome" as const,
    ...overrides,
  });

  it("première acceptation : l'âge puis les conditions", () => {
    const result = rowsToInsert([], input(), config);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.rows.map((r) => [r.purpose, r.granted, r.policy_version]), [["age_16", true, V1], ["terms", true, V1]]);
  });

  it("idempotent : la même demande une seconde fois n'ajoute rien", () => {
    const existing = [row("age_16", true, V1, t(1)), row("terms", true, V1, t(2))];
    const result = rowsToInsert(existing, input(), config);
    assert.equal(result.ok && result.rows.length, 0);
  });

  it("nouveau texte : seules les conditions sont réenregistrées", () => {
    const existing = [row("age_16", true, V1, t(1)), row("terms", true, V1, t(2))];
    const result = rowsToInsert(existing, input({ version: V2, ageAttested: false }), config);
    assert.equal(result.ok && result.rows.map((r) => r.purpose).join(","), "terms");
  });

  it("accepter les conditions sans confirmer l'âge est refusé", () => {
    const result = rowsToInsert([], input({ ageAttested: false }), config);
    assert.equal(result.ok, false);
  });

  it("accepter les conditions est possible si l'âge a déjà été confirmé", () => {
    const result = rowsToInsert([row("age_16", true, V1, t(1))], input({ ageAttested: false, version: V2 }), config);
    assert.equal(result.ok && result.rows.map((r) => r.purpose).join(","), "terms");
  });

  it("un choix ne s'enregistre que s'il change", () => {
    const existing = [row("ads_personalization", false, V1, t(1))];
    const same = rowsToInsert(existing, input({ acceptTerms: false, ageAttested: false, choices: { ads_personalization: false } }), config);
    assert.equal(same.ok && same.rows.length, 0);
    const changed = rowsToInsert(existing, input({ acceptTerms: false, ageAttested: false, choices: { ads_personalization: true } }), config);
    assert.equal(changed.ok && changed.rows.length, 1);
  });

  it("retirer puis redonner un consentement garde tout l'historique (une ligne par changement)", () => {
    const withdrawn = rowsToInsert([row("ads_personalization", true, V1, t(1))], input({ acceptTerms: false, ageAttested: false, choices: { ads_personalization: false } }), config);
    assert.equal(withdrawn.ok && withdrawn.rows[0].granted, false);
  });
});
