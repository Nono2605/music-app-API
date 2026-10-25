// Client de l'API de reconnaissance d'ACRCloud (POST /v1/identify, doc : docs.acrcloud.com, « Identification API »).
// On envoie un EXTRAIT d'une dizaine de secondes ; ACRCloud répond par les enregistrements connus qu'il reconnaît.
//
// Pur, sans accès à la base : le réseau est injecté (fetch), pour tester sans compte ni clé. Une panne, une clé fausse ou
// une limite dépassée LÈVE une erreur (jamais « aucun résultat » : « rien trouvé » et « n'a pas pu chercher » ne sont pas
// la même chose). Les messages d'erreur ne contiennent jamais la clé ni le secret.

import { createHmac } from "node:crypto";

export interface AcrCloudConfig {
  /** Hôte de VOTRE projet (affiché dans la console ACRCloud), par exemple identify-eu-west-1.acrcloud.com. */
  host: string;
  accessKey: string;
  accessSecret: string;
}

// Lit les trois réglages (ACRCLOUD_HOST, ACRCLOUD_ACCESS_KEY, ACRCLOUD_ACCESS_SECRET). null tant qu'il en manque un :
// le contrôle d'empreinte n'est alors simplement pas actif.
export function acrCloudConfigFrom(vars: Record<string, string | undefined>): AcrCloudConfig | null {
  const host = vars.ACRCLOUD_HOST?.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  const accessKey = vars.ACRCLOUD_ACCESS_KEY?.trim();
  const accessSecret = vars.ACRCLOUD_ACCESS_SECRET?.trim();
  if (!host || !accessKey || !accessSecret) return null;
  if (!/^[a-z0-9.-]+$/i.test(host)) return null;
  return { host, accessKey, accessSecret };
}

// Signature de la requête : HMAC-SHA1, clé = le secret, sur « méthode, chemin, clé d'accès, type de données, version de
// signature, horodatage » séparés par des sauts de ligne ; résultat en base64.
export function identifySignature(accessKey: string, accessSecret: string, timestamp: number | string): string {
  const toSign = ["POST", "/v1/identify", accessKey, "audio", "1", String(timestamp)].join("\n");
  return createHmac("sha1", accessSecret).update(toSign, "utf8").digest("base64");
}

export interface AcrMatch {
  /** « music » : enregistrement reconnu ; « cover » : reprise ou version live (moteur de reprises, s'il est activé). */
  source: "music" | "cover";
  title: string;
  artists: string[];
  album: string | null;
  /** 0 à 100 : plus c'est haut, plus la correspondance est sûre. */
  score: number;
  isrc: string | null;
  acrid: string | null;
  /** Où l'extrait tombe dans l'enregistrement connu, en millisecondes. */
  playOffsetMs: number | null;
  label: string | null;
  releaseDate: string | null;
}

export type IdentifyResult = { kind: "matches"; matches: AcrMatch[] } | { kind: "none" };

export class AcrCloudError extends Error {
  readonly code: number | null;
  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = "AcrCloudError";
    this.code = code;
  }
}

// Codes d'état de la doc d'ACRCloud (« Error Codes ») : 0 reconnu, 1001 rien trouvé ; le reste est une erreur.
const ERROR_TEXT: Record<number, string> = {
  2004: "unable to generate a fingerprint from the sample",
  3000: "recognition service error (wrong host?)",
  3001: "wrong access key",
  3002: "invalid HTTP request",
  3003: "request count limit exceeded: upgrade the ACRCloud account",
  3006: "invalid arguments",
  3010: "recognition service error",
  3014: "invalid signature (wrong access secret?)",
  3015: "queries-per-second limit exceeded: upgrade the ACRCloud account",
};

type Json = Record<string, unknown>;
const asObject = (value: unknown): Json | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null);
const asString = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const asNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function toMatch(entry: unknown, source: AcrMatch["source"]): AcrMatch | null {
  const item = asObject(entry);
  const title = asString(item?.title);
  if (!item || !title) return null;
  const artists = (Array.isArray(item.artists) ? item.artists : [])
    .map((artist) => asString(asObject(artist)?.name))
    .filter((name): name is string => name !== null);
  return {
    source,
    title,
    artists,
    album: asString(asObject(item.album)?.name),
    score: asNumber(item.score) ?? 0,
    isrc: asString(asObject(item.external_ids)?.isrc),
    acrid: asString(item.acrid),
    playOffsetMs: asNumber(item.play_offset_ms),
    label: asString(item.label),
    releaseDate: asString(item.release_date),
  };
}

// Lit la réponse JSON. 0 : les correspondances (de `metadata.music`, et de `metadata.humming` pour le moteur de reprises
// s'il est activé) ; 1001 : rien de reconnu ; tout autre code : erreur.
export function parseIdentifyResponse(body: unknown): IdentifyResult {
  const root = asObject(body);
  const status = asObject(root?.status);
  const code = asNumber(status?.code);
  if (code === null) throw new AcrCloudError("unreadable answer from ACRCloud");

  if (code === 1001) return { kind: "none" };
  if (code !== 0) {
    throw new AcrCloudError(`ACRCloud code ${code}: ${ERROR_TEXT[code] ?? asString(status?.msg) ?? "error"}`, code);
  }

  const metadata = asObject(root?.metadata);
  const music = Array.isArray(metadata?.music) ? metadata.music : [];
  const cover = Array.isArray(metadata?.humming) ? metadata.humming : [];
  const matches = [
    ...music.map((entry) => toMatch(entry, "music")),
    ...cover.map((entry) => toMatch(entry, "cover")),
  ].filter((match): match is AcrMatch => match !== null);

  return matches.length > 0 ? { kind: "matches", matches } : { kind: "none" };
}

export interface IdentifyOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** Reçoit la réponse JSON brute avant lecture (le test sur vos morceaux l'affiche pour voir les champs réels). */
  onResponse?: (body: unknown) => void;
}

// Envoie UN extrait (mp3, wav… moins de 5 Mo ; une quinzaine de secondes au plus donnent de meilleurs résultats).
export async function identifySample(config: AcrCloudConfig, sample: Uint8Array, options: IdentifyOptions = {}): Promise<IdentifyResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timestamp = Math.floor((options.now ?? Date.now)() / 1000);

  const form = new FormData();
  form.append("sample", new Blob([sample]), "sample.mp3");
  form.append("sample_bytes", String(sample.byteLength));
  form.append("access_key", config.accessKey);
  form.append("data_type", "audio");
  form.append("signature_version", "1");
  form.append("signature", identifySignature(config.accessKey, config.accessSecret, timestamp));
  form.append("timestamp", String(timestamp));

  let response: Response;
  try {
    response = await fetchImpl(`https://${config.host}/v1/identify`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (err) {
    throw new AcrCloudError(`ACRCloud unreachable: ${err instanceof Error ? err.message : "network error"}`);
  }
  if (!response.ok) throw new AcrCloudError(`ACRCloud answered HTTP ${response.status}`);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AcrCloudError("unreadable answer from ACRCloud");
  }
  options.onResponse?.(body);
  return parseIdentifyResponse(body);
}
