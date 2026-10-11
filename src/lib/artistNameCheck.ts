import { supabaseAdmin } from "./supabaseAdmin";
import { isMissingFunction } from "./schemaCompat";
import { suggestArtistNames, validateArtistName, type ArtistNameProblem } from "./artistName";

// Disponibilité d'un nom d'artiste : format (ici), puis mots réservés et unicité
// (fonction SQL artist_name_status, qui compare sans tenir compte des accents, des
// majuscules ni de . - _ ' & !). Les contraintes de la base restent le dernier filet.

export type NameCheck =
  | { status: "ok"; name: string; degraded?: boolean }
  | { status: "invalid"; name: string; code: ArtistNameProblem; message: string }
  | { status: "reserved"; name: string; message: string }
  | { status: "taken"; name: string; message: string; suggestions: string[] };

async function dbStatus(name: string, excludeArtistId: string | null): Promise<string | "unavailable"> {
  const { data, error } = await supabaseAdmin.rpc("artist_name_status", {
    p_name: name,
    p_exclude_artist: excludeArtistId,
  });
  if (error) {
    // Migration pas encore appliquée : on ne bloque personne, on le signale (degraded).
    if (isMissingFunction(error)) return "unavailable";
    throw error;
  }
  return String(data);
}

export async function checkArtistName(raw: unknown, excludeArtistId: string | null = null): Promise<NameCheck> {
  const v = validateArtistName(raw);
  if (!v.ok) return { status: "invalid", name: v.name, code: v.code, message: v.message };

  const status = await dbStatus(v.name, excludeArtistId);
  if (status === "unavailable") return { status: "ok", name: v.name, degraded: true };

  if (status === "reserved") {
    return { status: "reserved", name: v.name, message: "This name is reserved. Please choose another one." };
  }
  if (status === "taken") {
    const free: string[] = [];
    // Chaque proposition est vérifiée : on n'en suggère jamais une déjà prise.
    const candidates = suggestArtistNames(v.name);
    const results = await Promise.all(candidates.map((c) => dbStatus(c, excludeArtistId)));
    candidates.forEach((c, i) => {
      if (results[i] === "ok" && free.length < 3) free.push(c);
    });
    return {
      status: "taken",
      name: v.name,
      message: "This artist name is already taken.",
      suggestions: free,
    };
  }
  if (status === "invalid") {
    return { status: "invalid", name: v.name, code: "characters", message: "This name isn't valid." };
  }
  return { status: "ok", name: v.name };
}
