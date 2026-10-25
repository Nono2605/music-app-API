// Les contrôles automatiques d'un morceau envoyé en relecture (spec 15.5). Chacun est un petit module : il reçoit le
// morceau et ses fichiers, et rend un ou plusieurs résultats « ok / warn / fail ». Le journal (track_scans) et la
// décision de l'administrateur sont gérés ailleurs (scanRunner.ts).
//
// Un contrôle qui ne peut pas répondre (panne de base, de prestataire) LÈVE une erreur : l'exécuteur le journalise
// comme « indisponible », jamais comme « ok ». Contrôles de cette version : aucun prestataire, rien d'envoyé à l'extérieur.
// Le prestataire de reconnaissance (empreinte acoustique) viendra ici comme un contrôle de plus.

import { isBlockedChecksum, type BlockedDb } from "./blockedFiles";
import type { DuplicateDb } from "./duplicateFile";
import type { ScanRecord } from "./scanLog";
import { loadSimilarTracks, type TitleDb, type TrackLite } from "./similarTitle";

export type ScanTrack = TrackLite;

export interface ScanFile {
  id: string;
  checksum: string | null;
  storage_key: string;
}

export interface ScanContext {
  track: ScanTrack;
  /** Les fichiers du morceau, le plus ancien d'abord (celui qui est écouté). */
  files: ScanFile[];
  /** Une adresse signée, de courte durée, vers le premier fichier ; seulement pour les contrôles qui lisent l'audio. */
  audioUrl?: () => Promise<string | null>;
}

// Ce que rend un contrôle ; l'exécuteur y ajoute le morceau, l'artiste, le nom du contrôle et du prestataire.
export type ScanOutcome = Omit<ScanRecord, "check_kind" | "provider" | "provider_version" | "track_id" | "artist_id">;

export interface Scanner {
  /** La sorte de contrôle, telle qu'elle est écrite dans track_scans.check_kind. */
  kind: string;
  provider: string;
  version?: string;
  run(context: ScanContext): Promise<ScanOutcome[]>;
}

// Les empreintes SHA-256 distinctes des fichiers du morceau (un fichier sans empreinte ne se compare pas).
function checksumsOf(files: ScanFile[]): { checksum: string; fileId: string }[] {
  const seen = new Map<string, string>();
  for (const file of files) {
    if (file.checksum && !seen.has(file.checksum)) seen.set(file.checksum, file.id);
  }
  return [...seen].map(([checksum, fileId]) => ({ checksum, fileId }));
}

// Le MÊME fichier (octet pour octet) dans un morceau d'UN AUTRE artiste. L'envoi d'un tel fichier est déjà refusé ; ce
// contrôle rattrape ce qui est arrivé avant la règle, ou en même temps que l'autre envoi.
export function duplicateAudioScanner(db: DuplicateDb): Scanner {
  return {
    kind: "duplicate_audio",
    provider: "internal",
    async run({ track, files }) {
      const candidates = checksumsOf(files);
      if (candidates.length === 0) return [{ result: "ok", detail: { files: files.length, compared: 0 } }];

      for (const { checksum, fileId } of candidates) {
        const sameFile = await db.from("track_files").select("id, track_id").eq("checksum", checksum).limit(50);
        if (sameFile.error) throw sameFile.error;
        const trackIds = [...new Set((sameFile.data ?? []).map((row) => row.track_id))];
        if (trackIds.length === 0) continue;

        const others = await db.from("tracks").select("id, artist_id").in("id", trackIds).neq("artist_id", track.artist_id).limit(1);
        if (others.error) throw others.error;
        const other = others.data?.[0];
        if (other) {
          return [
            { result: "fail", track_file_id: fileId, matched_track_id: other.id, matched_artist_id: other.artist_id, detail: { compared: candidates.length } },
          ];
        }
      }
      return [{ result: "ok", detail: { compared: candidates.length } }];
    },
  };
}

// Un fichier de la liste de blocage (retiré après un signalement d'ayant droit).
export function blockedAudioScanner(db: BlockedDb): Scanner {
  return {
    kind: "blocked_audio",
    provider: "internal",
    async run({ files }) {
      const candidates = checksumsOf(files);
      for (const { checksum, fileId } of candidates) {
        if (await isBlockedChecksum(checksum, db)) return [{ result: "fail", track_file_id: fileId, detail: { compared: candidates.length } }];
      }
      return [{ result: "ok", detail: { compared: candidates.length } }];
    },
  };
}

// Même titre et même durée (à 2 secondes près) chez un autre artiste : un avertissement pour la relecture.
export function similarTitleScanner(db: TitleDb): Scanner {
  return {
    kind: "similar_title",
    provider: "internal",
    async run({ track }) {
      if (track.duration_seconds === null) return [{ result: "ok", detail: { skipped: "no duration" } }];
      const similar = await loadSimilarTracks(db, track);
      if (similar.length === 0) return [{ result: "ok", detail: { found: 0 } }];
      return [{ result: "warn", matched_track_id: similar[0].id, matched_artist_id: similar[0].artist_id, detail: { found: similar.length } }];
    },
  };
}
