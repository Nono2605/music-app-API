import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { errorResponse } from "./errorHandler";

describe("errorResponse", () => {
  it("ne laisse pas passer le message d'une erreur de base de données", () => {
    const postgrest = {
      code: "42703",
      message: 'column "secret_column" does not exist',
      details: null,
      hint: null,
    };
    const result = errorResponse(postgrest);
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { error: "Internal server error", code: "internal_error" });
    assert.doesNotMatch(JSON.stringify(result.body), /secret_column/);
  });

  it("ne laisse pas passer le message d'une exception ordinaire", () => {
    const result = errorResponse(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    assert.equal(result.status, 500);
    assert.doesNotMatch(JSON.stringify(result.body), /10\.0\.0\.5/);
  });

  it("garde le statut 4xx d'une erreur de lecture de la requête, avec un texte neutre", () => {
    const badJson = Object.assign(new SyntaxError("Unexpected token } in JSON at position 12"), { status: 400, type: "entity.parse.failed" });
    assert.deepEqual(errorResponse(badJson), { status: 400, body: { error: "Invalid request" } });

    const tooLarge = Object.assign(new Error("request entity too large"), { statusCode: 413 });
    assert.deepEqual(errorResponse(tooLarge), { status: 413, body: { error: "Request body too large" } });
  });

  it("un statut 4xx inconnu reçoit un texte générique", () => {
    assert.deepEqual(errorResponse({ status: 418 }), { status: 418, body: { error: "Request error" } });
  });

  it("un statut 5xx ou invalide reste une erreur 500 générique", () => {
    assert.equal(errorResponse({ status: 503 }).status, 500);
    assert.equal(errorResponse({ status: "400" }).status, 500);
    assert.equal(errorResponse(null).status, 500);
    assert.equal(errorResponse(undefined).status, 500);
    assert.equal(errorResponse("boom").status, 500);
  });
});
