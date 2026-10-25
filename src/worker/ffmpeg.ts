import { spawn } from "node:child_process";

// Les deux débits produits pour chaque morceau (voir lib/renditions.ts : standard = 128, high = 256).
export const BITRATES_KBPS = [128, 256] as const;

// AAC-LC dans un conteneur MP4 (.m4a), lisible partout (Chrome, Safari, Firefox, iOS, Android).
//   -vn                  pas d'image (pochette incluse) ; -map_metadata -1 : aucune étiquette recopiée
//   -ac 2 -ar 44100      stéréo, 44,1 kHz : un format unique, sûr pour tous les lecteurs
//   -movflags +faststart l'index du fichier en tête : la lecture démarre et on peut avancer sans tout télécharger
export function buildAacArgs(input: string, output: string, bitrateKbps: number): string[] {
  return [
    "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
    "-i", input,
    "-vn", "-map_metadata", "-1",
    "-c:a", "aac", "-b:a", `${bitrateKbps}k`, "-ac", "2", "-ar", "44100",
    "-movflags", "+faststart",
    "-f", "mp4", output,
  ];
}

const STDERR_KEPT = 2000;

// Lance ffmpeg et attend sa fin. Erreur avec la fin de ce qu'il a écrit si le code de sortie n'est pas 0 ; le processus
// est tué au bout de `timeoutMs`.
export function runFfmpeg(binary: string, args: string[], timeoutMs = 10 * 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_KEPT);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ffmpeg interrompu après ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg ne démarre pas : ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg a échoué (code ${code}) : ${stderr.trim() || "aucun message"}`));
    });
  });
}
