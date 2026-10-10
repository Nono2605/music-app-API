import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyHeartbeat,
  qualifyThreshold,
  type Heartbeat,
  type HeartbeatState,
  type PlayState,
  type PlayUpdate,
} from "./heartbeat";

const T0 = Date.parse("2026-10-09T12:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000);

function newPlay(overrides: Partial<PlayState> = {}): PlayState {
  return {
    last_heartbeat_at: at(0).toISOString(),
    last_position_seconds: 0,
    last_state: "started",
    last_seq: 0,
    validated_seconds: 0,
    track_duration_seconds: 200,
    qualified: false,
    ended_at: null,
    ...overrides,
  };
}

// Rejoue une chronologie de battements : chaque entrée = [seconde serveur, position, état].
function replay(timeline: Array<[number, number, HeartbeatState]>, initial: Partial<PlayState> = {}) {
  let play = newPlay(initial);
  const credits: number[] = [];
  let seq = play.last_seq;
  for (const [t, position_seconds, state] of timeline) {
    const hb: Heartbeat = { seq: ++seq, position_seconds, state };
    const outcome = applyHeartbeat(play, hb, at(t));
    assert.equal(outcome.kind, "applied", `battement à t=${t}`);
    if (outcome.kind !== "applied") throw new Error("inattendu");
    credits.push(outcome.credited_seconds);
    play = { ...play, ...(outcome.update as PlayUpdate), qualified: outcome.update.qualified ?? play.qualified } as PlayState;
  }
  return { play, credits };
}

describe("applyHeartbeat — écoute normale", () => {
  it("le premier battement ne crédite rien : il pose seulement la ligne de départ", () => {
    const { credits } = replay([[1, 0, "playing"]]);
    assert.deepEqual(credits, [0]);
  });

  it("écoute continue : 1 s crédité par seconde écoulée", () => {
    const { play, credits } = replay([
      [1, 0, "playing"],
      [16, 15, "playing"],
      [31, 30, "playing"],
      [46, 45, "playing"],
    ]);
    assert.deepEqual(credits, [0, 15, 15, 15]);
    assert.equal(play.validated_seconds, 45);
  });

  it("qualifiée au battement qui atteint 30 s (D1), pas avant, et qualified_at n'est pas réécrit", () => {
    let play = newPlay();
    const outcomes: Array<boolean | undefined> = [];
    for (const [i, [t, pos]] of ([[1, 0], [16, 15], [31, 30], [46, 45]] as Array<[number, number]>).entries()) {
      const o = applyHeartbeat(play, { seq: i + 1, position_seconds: pos, state: "playing" }, at(t));
      assert.equal(o.kind, "applied");
      if (o.kind !== "applied") return;
      outcomes.push(o.update.qualified);
      play = { ...play, ...o.update, qualified: o.update.qualified ?? play.qualified } as PlayState;
    }
    assert.deepEqual(outcomes, [undefined, undefined, true, undefined]);
  });

  it("pause puis reprise : la pause n'est pas créditée", () => {
    const { play, credits } = replay([
      [1, 0, "playing"],
      [11, 10, "paused"], // joué 10 s, puis pause
      [100, 10, "playing"], // 89 s de pause : rien
      [115, 25, "playing"], // 15 s de lecture
    ]);
    assert.deepEqual(credits, [0, 10, 0, 15]);
    assert.equal(play.validated_seconds, 25);
  });

  it("battements perdus : le suivant crédite tout l'intervalle d'après la position", () => {
    const { credits } = replay([
      [1, 0, "playing"],
      [61, 60, "playing"], // rien reçu pendant 60 s
    ]);
    assert.deepEqual(credits, [0, 60]);
  });

  it("fin de morceau : lecture close, marquée terminée", () => {
    const { play } = replay([
      [1, 0, "playing"],
      [16, 15, "playing"],
      [21, 20, "ended"],
    ], { track_duration_seconds: 20 });
    assert.equal(play.ended_at, at(21).toISOString());
    assert.equal(play.validated_seconds, 20);
  });

  it("fermeture (changement de morceau) : close mais pas « terminée »", () => {
    let play = newPlay({ last_state: "playing", last_position_seconds: 10, last_seq: 3, last_heartbeat_at: at(10).toISOString() });
    const o = applyHeartbeat(play, { seq: 4, position_seconds: 18, state: "closed" }, at(18));
    assert.equal(o.kind, "applied");
    if (o.kind !== "applied") return;
    assert.equal(o.update.completed, false);
    assert.equal(o.credited_seconds, 8);
    assert.ok(o.update.ended_at);
    play = { ...play, ...o.update } as PlayState;
  });
});

describe("applyHeartbeat — sauts et tentatives de triche", () => {
  it("saut en avant : au plus le temps écoulé, jamais la distance sautée", () => {
    const { credits } = replay([
      [1, 0, "playing"],
      [16, 115, "playing"], // +115 s de position en 15 s
    ]);
    assert.deepEqual(credits, [0, 15]);
  });

  it("saut en arrière : rien de crédité sur cet intervalle", () => {
    const { credits } = replay([
      [1, 100, "playing"],
      [16, 5, "playing"],
    ]);
    assert.deepEqual(credits, [0, 0]);
  });

  it("lecture accélérée ×2 : toujours 1 s par seconde réelle", () => {
    const { play } = replay([
      [1, 0, "playing"],
      [16, 30, "playing"],
      [31, 60, "playing"],
    ]);
    assert.equal(play.validated_seconds, 30);
  });

  it("un client qui prétend lire sans pause pendant une heure ne dépasse pas une heure", () => {
    const { play } = replay([
      [1, 0, "playing"],
      [3601, 3600, "playing"],
    ], { track_duration_seconds: null });
    assert.equal(play.validated_seconds, 3600);
  });

  it("plafond = durée du morceau : se replacer sans cesse au début ne gonfle pas le total", () => {
    // Joue 10 s, revient à 0, rejoue 10 s… dix fois, sur un morceau de 30 s.
    let play = newPlay({ track_duration_seconds: 30, last_state: "playing" });
    let t = 0;
    let seq = 0;
    for (let i = 0; i < 10; i++) {
      t += 10;
      for (const position of [10, 0]) {
        const o = applyHeartbeat(play, { seq: ++seq, position_seconds: position, state: "playing" }, at(t));
        assert.equal(o.kind, "applied");
        if (o.kind === "applied") play = { ...play, ...o.update, qualified: o.update.qualified ?? play.qualified } as PlayState;
        t += 0.1;
      }
    }
    assert.equal(play.validated_seconds, 30); // 100 s « jouées » au total, plafonné à la durée
  });

  it("durée du morceau inconnue : plafond de sécurité de 4 h", () => {
    const { play } = replay([
      [1, 0, "playing"],
      [100000, 100000, "playing"],
    ], { track_duration_seconds: null });
    assert.equal(play.validated_seconds, 4 * 3600);
  });

  it("horloge du serveur qui recule (temps écoulé négatif) : aucun crédit", () => {
    const { credits } = replay([
      [100, 0, "playing"],
      [90, 10, "playing"],
    ]);
    assert.deepEqual(credits, [0, 0]);
  });

  it("l'état précédent compte : après « paused », la reprise ne crédite rien même si la position a avancé", () => {
    const { credits } = replay([
      [1, 0, "paused"],
      [20, 19, "playing"],
    ]);
    assert.deepEqual(credits, [0, 0]);
  });
});

describe("applyHeartbeat — idempotence et lecture close", () => {
  it("un battement rejoué (même seq) est ignoré", () => {
    const play = newPlay({ last_seq: 5, last_state: "playing" });
    assert.equal(applyHeartbeat(play, { seq: 5, position_seconds: 50, state: "playing" }, at(50)).kind, "duplicate");
  });

  it("un battement plus ancien (seq inférieur) est ignoré", () => {
    const play = newPlay({ last_seq: 5, last_state: "playing" });
    assert.equal(applyHeartbeat(play, { seq: 3, position_seconds: 50, state: "playing" }, at(50)).kind, "duplicate");
  });

  it("une lecture déjà terminée refuse tout nouveau battement", () => {
    const play = newPlay({ ended_at: at(5).toISOString(), last_seq: 2 });
    assert.equal(applyHeartbeat(play, { seq: 3, position_seconds: 10, state: "playing" }, at(10)).kind, "closed");
  });

  it("ne modifie jamais l'objet reçu", () => {
    const play = newPlay({ last_state: "playing" });
    const copy = JSON.stringify(play);
    applyHeartbeat(play, { seq: 1, position_seconds: 10, state: "playing" }, at(10));
    assert.equal(JSON.stringify(play), copy);
  });
});

describe("qualification (D1)", () => {
  it("seuil : 30 s, ou presque la durée pour un morceau plus court", () => {
    assert.equal(qualifyThreshold(200), 30);
    assert.equal(qualifyThreshold(30), 30);
    assert.equal(qualifyThreshold(null), 30);
    assert.equal(qualifyThreshold(10), 9);
    assert.equal(qualifyThreshold(1), 0.5);
  });

  it("morceau de 10 s écouté en entier : qualifié", () => {
    const { play } = replay([
      [1, 0, "playing"],
      [10.6, 9.6, "playing"], // 9,6 s ≥ seuil de 9 s
    ], { track_duration_seconds: 10 });
    assert.equal(play.qualified, true);
  });

  it("morceau de 10 s écouté 5 s : pas qualifié", () => {
    const { play } = replay([
      [1, 0, "playing"],
      [6, 5, "closed"],
    ], { track_duration_seconds: 10 });
    assert.equal(play.qualified, false);
  });

  it("morceau long écouté 29 s : pas qualifié", () => {
    const { play } = replay([
      [1, 0, "playing"],
      [30, 29, "closed"],
    ]);
    assert.equal(play.qualified, false);
  });
});
