import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { acrCloudConfigFrom, acrCloudTuningFrom, AcrCloudError, identifySample, identifySignature, parseIdentifyResponse } from "./acrcloud";

describe("acrCloudConfigFrom", () => {
  const full = { ACRCLOUD_HOST: "identify-eu-west-1.acrcloud.com", ACRCLOUD_ACCESS_KEY: "key", ACRCLOUD_ACCESS_SECRET: "secret" };

  it("les trois réglages posés : actif", () => {
    assert.deepEqual(acrCloudConfigFrom(full), { host: "identify-eu-west-1.acrcloud.com", accessKey: "key", accessSecret: "secret" });
  });

  it("il en manque un (ou il est vide) : pas actif", () => {
    assert.equal(acrCloudConfigFrom({ ...full, ACRCLOUD_ACCESS_SECRET: undefined }), null);
    assert.equal(acrCloudConfigFrom({ ...full, ACRCLOUD_ACCESS_KEY: "  " }), null);
    assert.equal(acrCloudConfigFrom({}), null);
  });

  it("nettoie l'hôte collé avec https:// ou un chemin, et refuse un hôte qui n'en est pas un", () => {
    assert.equal(acrCloudConfigFrom({ ...full, ACRCLOUD_HOST: "https://identify-eu-west-1.acrcloud.com/v1/identify" })?.host, "identify-eu-west-1.acrcloud.com");
    assert.equal(acrCloudConfigFrom({ ...full, ACRCLOUD_HOST: "not a host!" }), null);
  });
});

describe("identifySignature", () => {
  it("HMAC-SHA1 en base64 de « POST, chemin, clé, audio, 1, horodatage » séparés par des sauts de ligne", () => {
    const expected = createHmac("sha1", "secret").update("POST\n/v1/identify\nkey\naudio\n1\n1700000000").digest("base64");
    assert.equal(identifySignature("key", "secret", 1700000000), expected);
  });

  it("valeur de référence figée (une modification de la règle se verrait ici)", () => {
    assert.equal(identifySignature("key", "secret", 1700000000), "tWbqxXkbyadGeaHIJS/OzfF+KdU=");
  });

  it("change avec le secret et avec l'horodatage", () => {
    const base = identifySignature("key", "secret", 1700000000);
    assert.notEqual(identifySignature("key", "other", 1700000000), base);
    assert.notEqual(identifySignature("key", "secret", 1700000001), base);
  });
});

const music = (overrides: Record<string, unknown> = {}) => ({
  title: "Drawing",
  artists: [{ name: "Anyma" }, { name: "Someone" }],
  album: { name: "Genesys" },
  score: 92,
  acrid: "abc123",
  external_ids: { isrc: "FR1234567890" },
  play_offset_ms: 9040,
  label: "Label",
  release_date: "2023-01-01",
  ...overrides,
});

describe("parseIdentifyResponse", () => {
  it("code 0 : les enregistrements reconnus, avec artistes, score, ISRC et position", () => {
    const result = parseIdentifyResponse({ status: { code: 0, msg: "Success" }, metadata: { music: [music()] } });
    assert.equal(result.kind, "matches");
    if (result.kind !== "matches") return;
    assert.deepEqual(result.matches[0], {
      source: "music",
      title: "Drawing",
      artists: ["Anyma", "Someone"],
      album: "Genesys",
      score: 92,
      isrc: "FR1234567890",
      acrid: "abc123",
      playOffsetMs: 9040,
      label: "Label",
      releaseDate: "2023-01-01",
    });
  });

  it("reprises (moteur de reprises) : lues aussi, marquées « cover »", () => {
    const result = parseIdentifyResponse({ status: { code: 0 }, metadata: { music: [music()], humming: [music({ title: "Cover of it", acrid: "zzz" })] } });
    assert.equal(result.kind, "matches");
    if (result.kind !== "matches") return;
    assert.deepEqual(result.matches.map((m) => [m.source, m.title]), [["music", "Drawing"], ["cover", "Cover of it"]]);
  });

  it("code 1001 : rien de reconnu, ce n'est pas une erreur", () => {
    assert.deepEqual(parseIdentifyResponse({ status: { code: 1001, msg: "No result" } }), { kind: "none" });
  });

  it("code 0 sans aucune entrée lisible : rien de reconnu", () => {
    assert.deepEqual(parseIdentifyResponse({ status: { code: 0 }, metadata: { music: [{ no: "title" }, null] } }), { kind: "none" });
  });

  it("clé fausse, signature refusée, limites : ERREUR avec le code, jamais « rien trouvé »", () => {
    for (const [code, text] of [[3001, /wrong access key/], [3014, /invalid signature/], [3003, /upgrade/], [3015, /per-second|queries-per-second/]] as const) {
      assert.throws(
        () => parseIdentifyResponse({ status: { code, msg: "x" } }),
        (err: unknown) => err instanceof AcrCloudError && err.code === code && text.test(err.message)
      );
    }
  });

  it("une réponse illisible est une erreur", () => {
    assert.throws(() => parseIdentifyResponse(null), AcrCloudError);
    assert.throws(() => parseIdentifyResponse({ status: {} }), AcrCloudError);
    assert.throws(() => parseIdentifyResponse("oops"), AcrCloudError);
  });
});

describe("identifySample", () => {
  const config = { host: "identify-eu-west-1.acrcloud.com", accessKey: "key", accessSecret: "secret" };
  const sample = new Uint8Array([1, 2, 3, 4]);

  function fakeFetch(respond: () => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return respond();
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  it("envoie l'extrait et les champs attendus, signés avec l'horodatage", async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json({ status: { code: 1001 } }));

    const result = await identifySample(config, sample, { fetchImpl, now: () => 1_700_000_000_000 });

    assert.deepEqual(result, { kind: "none" });
    assert.equal(calls[0].url, "https://identify-eu-west-1.acrcloud.com/v1/identify");
    assert.equal(calls[0].init.method, "POST");
    const form = calls[0].init.body as FormData;
    assert.equal(form.get("access_key"), "key");
    assert.equal(form.get("data_type"), "audio");
    assert.equal(form.get("signature_version"), "1");
    assert.equal(form.get("timestamp"), "1700000000");
    assert.equal(form.get("sample_bytes"), "4");
    assert.equal(form.get("signature"), identifySignature("key", "secret", 1700000000));
    assert.ok(form.get("sample") instanceof Blob);
    // Le secret ne part jamais dans la requête.
    assert.ok(![...form.values()].some((value) => value === "secret"));
  });

  it("rend les correspondances", async () => {
    const { fetchImpl } = fakeFetch(() => Response.json({ status: { code: 0 }, metadata: { music: [music()] } }));
    const result = await identifySample(config, sample, { fetchImpl });
    assert.equal(result.kind, "matches");
  });

  it("une erreur HTTP, un réseau coupé ou un corps illisible LÈVENT une erreur, sans jamais citer la clé ni le secret", async () => {
    const attempts: (() => Response | Promise<Response>)[] = [
      () => new Response("nope", { status: 502 }),
      () => Promise.reject(new Error("socket hang up")),
      () => new Response("<html>", { status: 200 }),
    ];
    for (const respond of attempts) {
      const { fetchImpl } = fakeFetch(respond);
      await assert.rejects(
        () => identifySample(config, sample, { fetchImpl }),
        (err: unknown) => err instanceof AcrCloudError && !/key|secret/i.test(err.message.replace(/access key|wrong access/gi, ""))
      );
    }
  });
});

describe("acrCloudTuningFrom", () => {
  it("sans réglage : seuil d'avertissement 60, jamais d'alerte grave automatique, 300 requêtes par mois", () => {
    assert.deepEqual(acrCloudTuningFrom({}), { warnScore: 60, failScore: null, monthlyCap: 300 });
  });

  it("lit les trois réglages", () => {
    assert.deepEqual(
      acrCloudTuningFrom({ ACRCLOUD_WARN_SCORE: "75", ACRCLOUD_FAIL_SCORE: "95", ACRCLOUD_MONTHLY_REQUESTS: "1000" }),
      { warnScore: 75, failScore: 95, monthlyCap: 1000 }
    );
  });

  it("une valeur vide, négative ou illisible est ignorée (défaut, ou « jamais » pour l'alerte grave)", () => {
    assert.deepEqual(
      acrCloudTuningFrom({ ACRCLOUD_WARN_SCORE: "  ", ACRCLOUD_FAIL_SCORE: "oui", ACRCLOUD_MONTHLY_REQUESTS: "-5" }),
      { warnScore: 60, failScore: null, monthlyCap: 300 }
    );
  });

  it("zéro est une valeur permise (un plafond à 0 coupe le contrôle)", () => {
    assert.equal(acrCloudTuningFrom({ ACRCLOUD_MONTHLY_REQUESTS: "0" }).monthlyCap, 0);
  });
});
