import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AcrMatch, IdentifyResult } from "./acrcloud";
import { fingerprintScanner, mergeMatches, type FingerprintDeps } from "./fingerprintScanner";
import type { ScanContext, ScanOutcome } from "./scanners";

const match = (overrides: Partial<AcrMatch> = {}): AcrMatch => ({
  source: "music",
  title: "Drawing",
  artists: ["Anyma"],
  album: null,
  score: 90,
  isrc: null,
  acrid: "a1",
  playOffsetMs: 1000,
  label: null,
  releaseDate: null,
  ...overrides,
});
const matches = (...list: AcrMatch[]): IdentifyResult => ({ kind: "matches", matches: list });
const none: IdentifyResult = { kind: "none" };

const context = (overrides: Partial<ScanContext> = {}): ScanContext => ({
  track: { id: "t1", title: "Mashup", duration_seconds: 200, artist_id: "a1" },
  files: [{ id: "f1", checksum: "cd".repeat(32), storage_key: "k" }],
  audioUrl: async () => "https://signed.example/audio",
  ...overrides,
});

// Des dépendances en mémoire, avec le journal des appels.
function fakeDeps(overrides: Partial<FingerprintDeps> = {}, answers: IdentifyResult[] = []) {
  const calls = { cuts: [] as number[], identified: 0, opened: [] as string[], closed: 0 };
  const deps: FingerprintDeps = {
    identify: async () => {
      calls.identified++;
      return answers.shift() ?? none;
    },
    openSampler: async (url) => {
      calls.opened.push(url);
      return {
        cut: async (start) => {
          calls.cuts.push(start);
          return Buffer.from("sample");
        },
        close: async () => void calls.closed++,
      };
    },
    requestsThisMonth: async () => 0,
    previous: async () => null,
    warnScore: 60,
    monthlyCap: 300,
    ...overrides,
  };
  return { deps, calls };
}

describe("mergeMatches", () => {
  it("le même enregistrement reconnu dans plusieurs extraits n'est qu'UNE correspondance, avec le meilleur score et les endroits", () => {
    const merged = mergeMatches([
      { offset: 44, result: matches(match({ score: 70 })) },
      { offset: 94, result: matches(match({ score: 95 })) },
      { offset: 144, result: none },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].score, 95);
    assert.deepEqual(merged[0].seenAtSeconds, [44, 94]);
  });

  it("des enregistrements différents (un mashup) restent séparés, du meilleur score au moins bon", () => {
    const merged = mergeMatches([
      { offset: 44, result: matches(match({ title: "Song A", acrid: "A", score: 80 })) },
      { offset: 94, result: matches(match({ title: "Song B", acrid: "B", score: 88 })) },
    ]);
    assert.deepEqual(merged.map((m) => m.title), ["Song B", "Song A"]);
  });
});

describe("fingerprintScanner", () => {
  it("rien de reconnu : ok, avec le nombre de requêtes et l'empreinte du fichier", async () => {
    const { deps, calls } = fakeDeps();

    const [outcome] = await fingerprintScanner(deps).run(context());

    assert.equal(outcome.result, "ok");
    assert.equal(outcome.score, null);
    assert.equal(calls.identified, 3);
    assert.equal(outcome.track_file_id, "f1");
    assert.equal((outcome.detail as Record<string, unknown>).requests, 3);
    assert.equal((outcome.detail as Record<string, unknown>).file_checksum, "cd".repeat(32));
  });

  it("une reconnaissance au-dessus du seuil : warn (à relire), avec ce qui a été reconnu", async () => {
    const { deps } = fakeDeps({}, [none, matches(match({ score: 92 })), none]);

    const [outcome] = await fingerprintScanner(deps).run(context());

    assert.equal(outcome.result, "warn");
    assert.equal(outcome.score, 92);
    const found = (outcome.detail as { matches: { title: string; artists: string[]; seen_at_seconds: number[] }[] }).matches;
    assert.equal(found[0].title, "Drawing");
    assert.deepEqual(found[0].artists, ["Anyma"]);
    assert.deepEqual(found[0].seen_at_seconds, [94]);
  });

  it("sous le seuil : ok, mais la correspondance faible reste dans le détail", async () => {
    const { deps } = fakeDeps({}, [matches(match({ score: 40 })), none, none]);

    const [outcome] = await fingerprintScanner(deps).run(context());

    assert.equal(outcome.result, "ok");
    assert.equal(outcome.score, 40);
    assert.equal((outcome.detail as { matches: unknown[] }).matches.length, 1);
  });

  it("jamais « fail » sans seuil réglé ; avec un seuil, fail à partir de ce score", async () => {
    const strong = [matches(match({ score: 99 })), none, none];
    const without = fakeDeps({}, [...strong]);
    assert.equal((await fingerprintScanner(without.deps).run(context()))[0].result, "warn");

    const withThreshold = fakeDeps({ failScore: 95 }, [...strong]);
    assert.equal((await fingerprintScanner(withThreshold.deps).run(context()))[0].result, "fail");

    const below = fakeDeps({ failScore: 95 }, [matches(match({ score: 80 })), none, none]);
    assert.equal((await fingerprintScanner(below.deps).run(context()))[0].result, "warn");
  });

  it("le plafond mensuel : au-dessus, ERREUR (indisponible), aucune requête envoyée", async () => {
    const { deps, calls } = fakeDeps({ requestsThisMonth: async () => 299, monthlyCap: 300 });

    await assert.rejects(() => fingerprintScanner(deps).run(context()), /monthly request cap reached/);
    assert.equal(calls.identified, 0);
    assert.equal(calls.cuts.length, 0);
  });

  it("pile au plafond : encore permis", async () => {
    const { deps, calls } = fakeDeps({ requestsThisMonth: async () => 297, monthlyCap: 300 });

    await fingerprintScanner(deps).run(context());

    assert.equal(calls.identified, 3);
  });

  it("un fichier déjà contrôlé (même empreinte) : résultat repris, AUCUNE requête, 0 requête comptée", async () => {
    const previous: ScanOutcome = { result: "warn", score: 91, track_file_id: "f1", detail: { requests: 3, file_checksum: "cd".repeat(32), matches: [{ title: "Drawing" }] } };
    const { deps, calls } = fakeDeps({ previous: async () => previous });

    const [outcome] = await fingerprintScanner(deps).run(context());

    assert.equal(outcome.result, "warn");
    assert.equal(outcome.score, 91);
    assert.equal((outcome.detail as Record<string, unknown>).reused, true);
    assert.equal((outcome.detail as Record<string, unknown>).requests, 0);
    assert.equal(calls.identified, 0);
  });

  it("une panne du prestataire LÈVE l'erreur (jamais « ok »)", async () => {
    const { deps } = fakeDeps({ identify: async () => { throw new Error("ACRCloud code 3001: wrong access key"); } });

    await assert.rejects(() => fingerprintScanner(deps).run(context()), /wrong access key/);
  });

  it("pas de fichier, ou pas d'adresse signée : ERREUR", async () => {
    const { deps } = fakeDeps();
    await assert.rejects(() => fingerprintScanner(deps).run(context({ files: [] })), /no audio file/);
    await assert.rejects(() => fingerprintScanner(deps).run(context({ audioUrl: async () => null })), /no audio address/);
    await assert.rejects(() => fingerprintScanner(deps).run(context({ audioUrl: undefined })), /no audio address/);
  });

  it("la durée du morceau décide des extraits : un morceau court n'en envoie qu'un", async () => {
    const { deps, calls } = fakeDeps();

    await fingerprintScanner(deps).run(context({ track: { id: "t1", title: "Short", duration_seconds: 15, artist_id: "a1" } }));

    assert.equal(calls.identified, 1);
  });

  it("télécharge le morceau UNE seule fois et en découpe tous les extraits, puis supprime la copie", async () => {
    const { deps, calls } = fakeDeps();

    await fingerprintScanner(deps).run(context());

    assert.deepEqual(calls.opened, ["https://signed.example/audio"]);
    assert.equal(calls.cuts.length, 3);
    assert.equal(calls.closed, 1);
  });

  it("la copie est supprimée même si le prestataire échoue en cours de route", async () => {
    const { deps, calls } = fakeDeps({ identify: async () => { throw new Error("ACRCloud unreachable: network error"); } });

    await assert.rejects(() => fingerprintScanner(deps).run(context()), /unreachable/);
    assert.equal(calls.closed, 1);
  });

  it("rien n'est téléchargé quand le plafond est atteint, ni quand le résultat est repris", async () => {
    const capped = fakeDeps({ requestsThisMonth: async () => 300, monthlyCap: 300 });
    await assert.rejects(() => fingerprintScanner(capped.deps).run(context()), /cap reached/);
    assert.equal(capped.calls.opened.length, 0);

    const reused = fakeDeps({ previous: async () => ({ result: "ok", score: null, detail: {} }) });
    await fingerprintScanner(reused.deps).run(context());
    assert.equal(reused.calls.opened.length, 0);
  });

  it("un téléchargement qui échoue LÈVE l'erreur (indisponible), sans requête au prestataire", async () => {
    const { deps, calls } = fakeDeps({ openSampler: async () => { throw new Error("audio download failed (HTTP 400)"); } });

    await assert.rejects(() => fingerprintScanner(deps).run(context()), /download failed/);
    assert.equal(calls.identified, 0);
  });
});

