// Le contrôle « empreinte » : quelques extraits du morceau sont envoyés à ACRCloud, qui dit s'il reconnaît des
// enregistrements connus (spec 15.5, D3). Il ne remplace pas votre écoute : il signale ce qui mérite d'être écouté
// de près (une copie, un mashup, un sample), il ne prouve rien, et il ne reconnaît pas un morceau NEUF qui ressemble
// à une œuvre protégée.
//
// Règles :
//  - jamais de refus automatique par défaut : une reconnaissance donne « warn » (à relire) ; « fail » n'existe que si un
//    seuil est réglé (ACRCLOUD_FAIL_SCORE), à décider après le test sur vos propres morceaux ;
//  - « rien reconnu » est « ok » ; « n'a pas pu chercher » (clé fausse, limite atteinte, réseau) LÈVE une erreur,
//    journalisée « indisponible » par l'exécuteur : jamais confondu avec « ok » ;
//  - plafond mensuel de requêtes (ACRCLOUD_MONTHLY_REQUESTS) : au plafond, le contrôle est « indisponible » plutôt que
//    de dépenser sans le savoir ;
//  - un fichier déjà contrôlé (même empreinte SHA-256) n'est pas renvoyé : le résultat est repris, sans nouvelle requête ;
//  - ce que le prestataire a reconnu n'est lu que par l'administration (track_scans), jamais montré à l'artiste.

import type { AcrMatch, IdentifyResult } from "./acrcloud";
import { sampleOffsets } from "./audioSamples";
import type { ScanOutcome, Scanner } from "./scanners";

export interface FingerprintDeps {
  /** Envoie un extrait au prestataire. */
  identify(sample: Buffer): Promise<IdentifyResult>;
  /** Découpe l'extrait qui commence à `startSeconds` dans le fichier (adresse signée). */
  cut(url: string, startSeconds: number): Promise<Buffer>;
  /** Requêtes déjà envoyées ce mois-ci (pour le plafond). */
  requestsThisMonth(): Promise<number>;
  /** Un résultat déjà obtenu pour le MÊME fichier de ce morceau, à reprendre ; null s'il n'y en a pas. */
  previous(trackId: string, checksum: string): Promise<ScanOutcome | null>;
  /** Score (0 à 100) à partir duquel une reconnaissance est un avertissement. */
  warnScore: number;
  /** Score à partir duquel c'est une alerte grave ; undefined : jamais (décision humaine). */
  failScore?: number;
  /** Requêtes par mois au plus. */
  monthlyCap: number;
  /** Extraits par morceau (3 par défaut). */
  samples?: number;
  version?: string;
}

const KEPT_MATCHES = 5;

interface SeenMatch extends AcrMatch {
  seenAtSeconds: number[];
}

// Les correspondances de tous les extraits, une seule fois chacune (le même enregistrement reconnu dans trois extraits
// n'est qu'une correspondance), avec le meilleur score et les endroits du morceau où elle a été entendue.
export function mergeMatches(perSample: { offset: number; result: IdentifyResult }[]): SeenMatch[] {
  const merged = new Map<string, SeenMatch>();
  for (const { offset, result } of perSample) {
    if (result.kind !== "matches") continue;
    for (const match of result.matches) {
      const key = match.acrid ?? `${match.title}|${match.artists.join(",")}`.toLowerCase();
      const seen = merged.get(key);
      if (!seen) merged.set(key, { ...match, seenAtSeconds: [offset] });
      else {
        seen.score = Math.max(seen.score, match.score);
        if (!seen.seenAtSeconds.includes(offset)) seen.seenAtSeconds.push(offset);
      }
    }
  }
  return [...merged.values()].sort((a, b) => b.score - a.score);
}

export function fingerprintScanner(deps: FingerprintDeps): Scanner {
  return {
    kind: "fingerprint",
    provider: "acrcloud",
    version: deps.version,
    async run(context) {
      const file = context.files[0];
      if (!file) throw new Error("no audio file to sample");

      // Déjà contrôlé : on reprend le résultat, on ne paie pas deux fois (la release, puis le morceau, sont envoyés à tour de rôle).
      if (file.checksum) {
        const previous = await deps.previous(context.track.id, file.checksum);
        if (previous) return [{ ...previous, detail: { ...previous.detail, reused: true, requests: 0 } }];
      }

      const url = await context.audioUrl?.();
      if (!url) throw new Error("no audio address to sample");

      const offsets = sampleOffsets(context.track.duration_seconds, deps.samples);
      const used = await deps.requestsThisMonth();
      if (used + offsets.length > deps.monthlyCap) {
        throw new Error(`monthly request cap reached (${used} of ${deps.monthlyCap} used)`);
      }

      const perSample: { offset: number; result: IdentifyResult }[] = [];
      for (const offset of offsets) {
        const sample = await deps.cut(url, offset);
        perSample.push({ offset, result: await deps.identify(sample) });
      }

      const matches = mergeMatches(perSample);
      const best = matches[0]?.score ?? null;
      const result: ScanOutcome["result"] =
        best === null ? "ok" : deps.failScore !== undefined && best >= deps.failScore ? "fail" : best >= deps.warnScore ? "warn" : "ok";

      return [
        {
          result,
          score: best,
          track_file_id: file.id,
          detail: {
            requests: offsets.length,
            samples: offsets,
            file_checksum: file.checksum,
            matches: matches.slice(0, KEPT_MATCHES).map((match) => ({
              source: match.source,
              title: match.title,
              artists: match.artists,
              album: match.album,
              score: match.score,
              isrc: match.isrc,
              acrid: match.acrid,
              play_offset_ms: match.playOffsetMs,
              seen_at_seconds: match.seenAtSeconds,
            })),
          },
        },
      ];
    },
  };
}
