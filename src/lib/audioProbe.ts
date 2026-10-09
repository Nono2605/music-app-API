import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

// Mesure d'un fichier audio déjà uploadé : format réel, durée, débit, taille et
// empreinte (SHA-256), lus sur le fichier lui-même. Rien de ce que déclare le
// client n'est cru : ni l'extension, ni le format, ni la taille.

export type AudioFormat = "mp3" | "flac" | "wav" | "ogg" | "m4a";

export type AudioProbeFailure =
  | "not_found" // l'objet n'existe pas dans le stockage
  | "unreachable" // erreur réseau / délai dépassé en le lisant
  | "too_large"
  | "not_audio" // illisible, corrompu ou pas de l'audio
  | "unsupported" // de l'audio, mais un format que le lecteur ne sait pas jouer
  | "no_duration"; // durée absente ou hors limites

export class AudioProbeError extends Error {
  constructor(
    readonly reason: AudioProbeFailure,
    message: string
  ) {
    super(message);
    this.name = "AudioProbeError";
  }
}

export interface AudioProbe {
  format: AudioFormat;
  codec: string;
  /** Durée mesurée sur le fichier, arrondie à la seconde (colonne integer). */
  durationSeconds: number;
  bitrateKbps: number | null;
  /** Octets réellement lus, pas la taille déclarée par le client. */
  sizeBytes: number;
  sha256: string;
}

export const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
const MIN_DURATION_SECONDS = 1;
const MAX_DURATION_SECONDS = 4 * 60 * 60;
const DEFAULT_TIMEOUT_MS = 120_000;

// Formats que le lecteur web sait jouer dans les navigateurs courants : MP3,
// FLAC, WAV (PCM entier ou flottant), Ogg (Vorbis/Opus) et M4A (AAC). On exclut
// notamment ALAC et AIFF (Safari seulement), les WAV compressés (ADPCM, A-law :
// refusés par Chrome) et les fichiers vidéo (MP4 avec image).
export function classifyAudio(format: {
  container?: string;
  codec?: string;
  hasVideo?: boolean;
  bitsPerSample?: number;
}): AudioFormat | null {
  if (format.hasVideo) return null;
  const container = (format.container ?? "").toLowerCase();
  const codec = format.codec ?? "";

  if (container === "mpeg" && /layer 3/i.test(codec)) return "mp3";
  if (container === "flac") return "flac";
  if (container === "wave") {
    if (/^(pcm|ieee_float)/i.test(codec)) return "wav";
    // WAVE_FORMAT_EXTENSIBLE (étiquette 65534) : ce que les logiciels de
    // production écrivent pour le 24 et le 32 bits. music-metadata n'en expose
    // pas le sous-format ; en pratique c'est du PCM ou du flottant, que Chrome
    // joue (vérifié sur 16/24/32 bits entiers et 32 bits flottant).
    if (/\(65534\)/.test(codec) && (format.bitsPerSample === 24 || format.bitsPerSample === 32)) return "wav";
    return null;
  }
  if (container === "ogg" && /vorbis|opus/i.test(codec)) return "ogg";
  // Le conteneur MP4 est décrit par ses marques ("M4A/isom/iso2", "mp42"…).
  if (/(^|\/)(m4a|m4b|isom|iso2|mp41|mp42)(\/|$)/.test(container) && /aac/i.test(codec)) return "m4a";
  return null;
}

function describeLimit(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Compte les octets, calcule l'empreinte au fil du flux, et coupe dès que la
// taille maximale est dépassée (sans attendre la fin du téléchargement).
class Meter extends Transform {
  bytes = 0;
  readonly hash = createHash("sha256");

  constructor(private readonly maxBytes: number) {
    super();
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      return callback(new AudioProbeError("too_large", `The file is larger than ${describeLimit(this.maxBytes)}`));
    }
    this.hash.update(chunk);
    callback(null, chunk);
  }
}

/**
 * Télécharge le fichier (flux vers un fichier temporaire : pas de fichier entier
 * en mémoire) puis le mesure. `url` est typiquement une URL signée de courte
 * durée vers le stockage.
 */
export async function probeAudioUrl(
  url: string,
  options: { maxBytes?: number; timeoutMs?: number } = {}
): Promise<AudioProbe> {
  const maxBytes = options.maxBytes ?? MAX_AUDIO_BYTES;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
  } catch {
    throw new AudioProbeError("unreachable", "Could not read the uploaded file");
  }
  if (response.status === 400 || response.status === 404) {
    // Le stockage répond 400 (et non 404) pour un objet inexistant.
    await response.body?.cancel().catch(() => {});
    throw new AudioProbeError("not_found", "The uploaded file could not be found");
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new AudioProbeError("unreachable", "Could not read the uploaded file");
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body.cancel().catch(() => {});
    throw new AudioProbeError("too_large", `The file is larger than ${describeLimit(maxBytes)}`);
  }

  // Nom de fichier volontairement neutre : music-metadata s'appuie sur
  // l'extension quand il y en a une (un WAV renommé en .mp3 serait mal lu).
  // Sans extension il détecte le format d'après le contenu.
  const dir = await mkdtemp(join(tmpdir(), "vynl-audio-"));
  const file = join(dir, "upload");
  try {
    const meter = new Meter(maxBytes);
    try {
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(file));
    } catch (err) {
      if (err instanceof AudioProbeError) throw err;
      throw new AudioProbeError("unreachable", "Could not read the uploaded file");
    }
    if (meter.bytes === 0) {
      throw new AudioProbeError("not_audio", "The uploaded file is empty");
    }

    // music-metadata est ESM seulement ; l'import dynamique fonctionne depuis ce
    // module CommonJS avec "module": "nodenext".
    const { parseFile } = await import("music-metadata");
    let info;
    try {
      // duration: true : pour un MP3 sans en-tête de durée, parcourt les trames
      // au lieu d'estimer d'après le débit des premières.
      info = (await parseFile(file, { duration: true })).format;
    } catch {
      throw new AudioProbeError(
        "not_audio",
        "This file could not be read as audio. It may be corrupt, incomplete, or not an audio file."
      );
    }

    const format = classifyAudio(info);
    if (!format) {
      throw new AudioProbeError(
        "unsupported",
        "Unsupported audio format. Use MP3, FLAC, WAV (PCM), Ogg (Vorbis or Opus) or M4A (AAC)."
      );
    }

    const duration = info.duration;
    if (
      typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      duration < MIN_DURATION_SECONDS ||
      duration > MAX_DURATION_SECONDS
    ) {
      throw new AudioProbeError(
        "no_duration",
        "The audio duration could not be determined, or is outside the accepted range (1 second to 4 hours)."
      );
    }

    return {
      format,
      codec: info.codec ?? format,
      durationSeconds: Math.round(duration),
      bitrateKbps: typeof info.bitrate === "number" ? Math.round(info.bitrate / 1000) : null,
      sizeBytes: meter.bytes,
      sha256: meter.hash.digest("hex"),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
