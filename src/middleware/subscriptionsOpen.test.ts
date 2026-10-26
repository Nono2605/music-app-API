import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { createRequireSubscriptionsOpen, SUBSCRIPTIONS_CLOSED } from "./subscriptionsOpen";

function run(isOpen: boolean) {
  const sent: { status?: number; body?: unknown } = {};
  let nextCalled = false;
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  } as unknown as Response;
  createRequireSubscriptionsOpen(() => isOpen)({} as Request, res, () => {
    nextCalled = true;
  });
  return { sent, nextCalled };
}

describe("requireSubscriptionsOpen", () => {
  it("fermé (par défaut) : 403 avec un message lisible et un code, et la requête n'avance pas", () => {
    const { sent, nextCalled } = run(false);
    assert.equal(sent.status, 403);
    assert.deepEqual(sent.body, SUBSCRIPTIONS_CLOSED);
    assert.equal(nextCalled, false);
  });

  it("ouvert : la requête continue, sans réponse", () => {
    const { sent, nextCalled } = run(true);
    assert.equal(nextCalled, true);
    assert.equal(sent.status, undefined);
  });

  it("le message annonce l'ouverture après la bêta", () => {
    assert.match(SUBSCRIPTIONS_CLOSED.error, /after the beta/);
    assert.equal(SUBSCRIPTIONS_CLOSED.code, "subscriptions_closed");
  });
});
