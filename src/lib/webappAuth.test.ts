import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WEBAPP_SECRET_HEADER, clientHeadersFor, webappTrust } from "./webappAuth";

const SECRET = "a-long-random-secret-of-at-least-32-chars";

describe("webappTrust", () => {
  it("sans secret défini sur l'API : « unconfigured », comportement inchangé", () => {
    assert.equal(webappTrust({}, undefined), "unconfigured");
    assert.equal(webappTrust({ [WEBAPP_SECRET_HEADER]: "n'importe quoi" }, undefined), "unconfigured");
    assert.equal(webappTrust({}, ""), "unconfigured");
  });

  it("le bon secret : « trusted »", () => {
    assert.equal(webappTrust({ [WEBAPP_SECRET_HEADER]: SECRET }, SECRET), "trusted");
  });

  it("pas de secret, mauvais secret, secret de longueur différente : « untrusted »", () => {
    assert.equal(webappTrust({}, SECRET), "untrusted");
    assert.equal(webappTrust({ [WEBAPP_SECRET_HEADER]: "faux" }, SECRET), "untrusted");
    assert.equal(webappTrust({ [WEBAPP_SECRET_HEADER]: SECRET + "x" }, SECRET), "untrusted");
    assert.equal(webappTrust({ [WEBAPP_SECRET_HEADER]: SECRET.slice(0, -1) }, SECRET), "untrusted");
    assert.equal(webappTrust({ [WEBAPP_SECRET_HEADER]: "" }, SECRET), "untrusted");
  });

  it("la casse compte (c'est un secret)", () => {
    assert.equal(webappTrust({ [WEBAPP_SECRET_HEADER]: SECRET.toUpperCase() }, SECRET), "untrusted");
  });

  it("un en-tête répété : seule la première valeur compte", () => {
    assert.equal(webappTrust({ [WEBAPP_SECRET_HEADER]: [SECRET, "autre"] }, SECRET), "trusted");
    assert.equal(webappTrust({ [WEBAPP_SECRET_HEADER]: ["autre", SECRET] }, SECRET), "untrusted");
  });
});

describe("clientHeadersFor", () => {
  const headers = { "x-vynl-client-country": "CH", "x-vynl-client-ua": "Mozilla", [WEBAPP_SECRET_HEADER]: SECRET };

  it("requête de confiance : pays, appareil et IP sont utilisables", () => {
    assert.deepEqual(clientHeadersFor(headers, SECRET), headers);
  });

  it("requête qui n'est pas de l'app auditeur : on les ignore", () => {
    assert.deepEqual(clientHeadersFor({ "x-vynl-client-country": "CH" }, SECRET), {});
    assert.deepEqual(clientHeadersFor({ ...headers, [WEBAPP_SECRET_HEADER]: "faux" }, SECRET), {});
  });

  it("aucun secret défini : comme avant, on les utilise", () => {
    assert.deepEqual(clientHeadersFor({ "x-vynl-client-country": "CH" }, undefined), { "x-vynl-client-country": "CH" });
  });
});
