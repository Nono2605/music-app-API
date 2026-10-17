import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allowsExplicit, anyExplicit, hidesExplicit } from "./explicit";

describe("hidesExplicit", () => {
  it("seul explicit=false masque le contenu explicite", () => {
    assert.equal(hidesExplicit({ explicit: "false" }), true);
    for (const value of ["true", "", "0", "FALSE", ["false"], undefined, null, false]) {
      assert.equal(hidesExplicit({ explicit: value }), false, JSON.stringify(value));
    }
    assert.equal(hidesExplicit({}), false);
  });
});

describe("anyExplicit", () => {
  it("un album est explicite dès qu'un morceau l'est", () => {
    assert.equal(anyExplicit([{ explicit: false }, { explicit: true }]), true);
    assert.equal(anyExplicit([{ explicit: false }, { explicit: null }, {}]), false);
  });

  it("sans morceau : pas explicite", () => {
    assert.equal(anyExplicit([]), false);
    assert.equal(anyExplicit(null), false);
    assert.equal(anyExplicit(undefined), false);
  });
});

describe("allowsExplicit", () => {
  it("par défaut oui : sans profil, ou réglage absent", () => {
    assert.equal(allowsExplicit(null), true);
    assert.equal(allowsExplicit(undefined), true);
    assert.equal(allowsExplicit({}), true);
    assert.equal(allowsExplicit({ explicit_content: null }), true);
  });

  it("seul un false explicite refuse", () => {
    assert.equal(allowsExplicit({ explicit_content: true }), true);
    assert.equal(allowsExplicit({ explicit_content: false }), false);
  });
});
