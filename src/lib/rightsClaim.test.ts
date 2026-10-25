import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CLAIMS_PER_HOUR_LIMIT, claimReference, submitClaim, validateClaim, type ClaimDb, type ClaimRow } from "./rightsClaim";

const GOOD = {
  name: "  Jeanne Droit  ",
  email: "jeanne@example.org",
  organization: "Éditions Droit",
  capacity: "owner",
  claim_type: "recording",
  track_reference: "https://app.vynl.ch/track/abc",
  original_work: "Mon album « Soleil », sur Bandcamp",
  description: "Cet enregistrement reprend ma chanson à l'identique.",
  good_faith: true,
  website: "",
};
const NOW = new Date("2026-10-25T12:00:00Z");

describe("validateClaim", () => {
  it("accepte un formulaire complet et nettoie les espaces", () => {
    const result = validateClaim(GOOD);
    assert.equal(result.ok && !result.spam && result.row.claimant_name, "Jeanne Droit");
    assert.equal(result.ok && !result.spam && result.row.claimant_organization, "Éditions Droit");
    assert.equal(result.ok && !result.spam && result.row.good_faith_statement, true);
  });

  it("l'organisation est facultative", () => {
    const { organization: _organization, ...without } = GOOD;
    void _organization;
    const result = validateClaim(without);
    assert.equal(result.ok && !result.spam && result.row.claimant_organization, null);
  });

  it("champ piège rempli : on fait comme si de rien n'était (pas d'enregistrement)", () => {
    assert.deepEqual(validateClaim({ ...GOOD, website: "http://spam.example" }), { ok: true, spam: true });
  });

  it("refuse ce qui n'est pas un objet", () => {
    for (const body of [null, undefined, "texte", 42, [], [GOOD]]) assert.equal(validateClaim(body).ok, false);
  });

  it("refuse un champ obligatoire manquant ou vide, en nommant le champ", () => {
    for (const field of ["name", "email", "track_reference", "original_work", "description"]) {
      const empty = validateClaim({ ...GOOD, [field]: "   " });
      assert.equal(!empty.ok && empty.field, field);
      const missing = validateClaim({ ...GOOD, [field]: undefined });
      assert.equal(!missing.ok && missing.field, field);
    }
  });

  it("refuse des valeurs qui ne sont pas du texte", () => {
    assert.equal(validateClaim({ ...GOOD, name: 42 }).ok, false);
    assert.equal(validateClaim({ ...GOOD, description: { a: 1 } }).ok, false);
  });

  it("e-mail : une forme valide est exigée", () => {
    for (const email of ["pas-un-mail", "a@b", "a@b.c", "@b.com", "a b@c.com", "a@@b.com"]) {
      const result = validateClaim({ ...GOOD, email });
      assert.equal(!result.ok && result.field, "email", email);
    }
    assert.equal(validateClaim({ ...GOOD, email: "prenom.nom+tag@sous.domaine.ch" }).ok, true);
  });

  it("borne les longueurs comme la base", () => {
    assert.equal(validateClaim({ ...GOOD, name: "x".repeat(120) }).ok, true);
    assert.equal(validateClaim({ ...GOOD, name: "x".repeat(121) }).ok, false);
    assert.equal(validateClaim({ ...GOOD, description: "x".repeat(19) }).ok, false);
    assert.equal(validateClaim({ ...GOOD, description: "x".repeat(20) }).ok, true);
    assert.equal(validateClaim({ ...GOOD, description: "x".repeat(4001) }).ok, false);
    assert.equal(validateClaim({ ...GOOD, track_reference: "x".repeat(501) }).ok, false);
    assert.equal(validateClaim({ ...GOOD, original_work: "x".repeat(2001) }).ok, false);
    assert.equal(validateClaim({ ...GOOD, organization: "x".repeat(121) }).ok, false);
  });

  it("compte les points de code, pas les unités UTF-16 (comme char_length de Postgres)", () => {
    // 10 émojis = 20 unités UTF-16 mais 10 points de code : trop court pour une description (20 minimum).
    assert.equal(validateClaim({ ...GOOD, description: "🎵".repeat(10) }).ok, false);
    assert.equal(validateClaim({ ...GOOD, description: "🎵".repeat(20) }).ok, true);
    // 120 émojis = 240 unités mais 120 points de code : un nom de 120 est permis.
    assert.equal(validateClaim({ ...GOOD, name: "🎵".repeat(120) }).ok, true);
  });

  it("retire les caractères de contrôle, garde les retours à la ligne", () => {
    const result = validateClaim({ ...GOOD, description: "Première ligne\u0000 du texte.\nSeconde ligne\u0007 du texte." });
    assert.equal(result.ok && !result.spam && result.row.description, "Première ligne du texte.\nSeconde ligne du texte.");
  });

  it("qualité et type : seulement les valeurs prévues", () => {
    assert.equal(!validateClaim({ ...GOOD, capacity: "pirate" }).ok, true);
    assert.equal(!validateClaim({ ...GOOD, claim_type: "autre chose" }).ok, true);
    for (const capacity of ["owner", "agent", "performer"]) assert.equal(validateClaim({ ...GOOD, capacity }).ok, true);
    for (const claim_type of ["recording", "composition", "voice_or_likeness", "name_or_trademark", "other"]) {
      assert.equal(validateClaim({ ...GOOD, claim_type }).ok, true);
    }
  });

  it("la déclaration de bonne foi doit être exactement vraie", () => {
    for (const good_faith of [false, "true", 1, undefined, null]) {
      const result = validateClaim({ ...GOOD, good_faith });
      assert.equal(!result.ok && result.field, "good_faith");
    }
  });
});

describe("claimReference", () => {
  it("complète à cinq chiffres", () => {
    assert.equal(claimReference(12), "RC-00012");
    assert.equal(claimReference("7"), "RC-00007");
    assert.equal(claimReference(123456), "RC-123456");
  });
});

describe("submitClaim", () => {
  function fakeDb(over: Partial<ClaimDb> = {}) {
    const inserted: ClaimRow[] = [];
    const db: ClaimDb = {
      countSince: async () => 0,
      insert: async (row) => (inserted.push(row), { claim_number: 12 }),
      ...over,
    };
    return { db, inserted };
  }

  it("enregistre et rend uniquement le numéro de dossier", async () => {
    const { db, inserted } = fakeDb();
    const result = await submitClaim(db, GOOD, NOW);
    assert.deepEqual(result, { status: 201, body: { reference: "RC-00012" } });
    assert.equal(inserted.length, 1);
    assert.equal(JSON.stringify(result.body).includes("jeanne"), false);
  });

  it("formulaire invalide : 400 avec le champ, rien n'est enregistré ni compté", async () => {
    let counted = false;
    const { db, inserted } = fakeDb({ countSince: async () => ((counted = true), 0) });
    const result = await submitClaim(db, { ...GOOD, email: "nope" }, NOW);
    assert.equal(result.status, 400);
    assert.equal(result.body.field, "email");
    assert.equal(inserted.length, 0);
    assert.equal(counted, false);
  });

  it("robot (champ piège) : un faux numéro de dossier, rien n'est enregistré", async () => {
    const { db, inserted } = fakeDb();
    const result = await submitClaim(db, { ...GOOD, website: "x" }, NOW, () => 0.5);
    assert.equal(result.status, 201);
    assert.match(String(result.body.reference), /^RC-\d{5}$/);
    assert.equal(inserted.length, 0);
  });

  it("plafond horaire : 429 sans enregistrer, en comptant sur la dernière heure", async () => {
    let since = "";
    const { db, inserted } = fakeDb({ countSince: async (iso) => ((since = iso), CLAIMS_PER_HOUR_LIMIT) });
    const result = await submitClaim(db, GOOD, NOW);
    assert.equal(result.status, 429);
    assert.equal(result.body.code, "claims_busy");
    assert.equal(since, "2026-10-25T11:00:00.000Z");
    assert.equal(inserted.length, 0);
  });

  it("juste sous le plafond : accepté", async () => {
    const { db } = fakeDb({ countSince: async () => CLAIMS_PER_HOUR_LIMIT - 1 });
    assert.equal((await submitClaim(db, GOOD, NOW)).status, 201);
  });

  it("migration pas appliquée (table absente) : 503, pas une erreur 500", async () => {
    const { db } = fakeDb({ countSince: async () => { throw { code: "42P01" }; } });
    const result = await submitClaim(db, GOOD, NOW);
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "unavailable");
  });

  it("toute autre panne remonte (le gestionnaire d'erreurs répond 500)", async () => {
    const boom = new Error("base en panne");
    const { db } = fakeDb({ insert: async () => { throw boom; } });
    await assert.rejects(() => submitClaim(db, GOOD, NOW), boom);
  });
});
