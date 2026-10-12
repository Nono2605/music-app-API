import { supabaseAdmin } from "./supabaseAdmin";
import { isMissingFunction } from "./schemaCompat";
import { suggestArtistNames, validateArtistName, type ArtistNameProblem } from "./artistName";

// Disponibilité d'un nom d'artiste : format (ici), puis mots réservés et unicité
// (fonction SQL artist_name_status, qui compare sans tenir compte des accents, des
// majuscules ni de . - _ ' & !). Les contraintes de la base restent le dernier filet.

export type NameCheck =
  | { status: "ok"; name: string; degraded?: boolean; similar?: SimilarName[] }
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
  return { status: "ok", name: v.name, similar: await similarNames(v.name, excludeArtistId) };
}

// Noms d'artistes qui RESSEMBLENT au nom demandé (fonction SQL similar_artist_names : similarité de
// trigrammes sur la clé du nom). Avertissement seulement : plusieurs artistes peuvent légitimement
// porter des noms proches, le risque est l'imitation d'un artiste connu. En cas d'erreur ou de migration
// absente, on ne signale rien plutôt que de bloquer la création.
export interface SimilarName {
  artist_id: string;
  name: string;
  similarity: number;
}

export function toSimilarNames(rows: unknown): SimilarName[] {
  if (!Array.isArray(rows)) return [];
  const out: SimilarName[] = [];
  for (const row of rows) {
    const r = row as { artist_id?: unknown; name?: unknown; similarity?: unknown };
    if (typeof r?.artist_id === "string" && typeof r.name === "string" && Number.isFinite(Number(r.similarity))) {
      out.push({ artist_id: r.artist_id, name: r.name, similarity: Number(r.similarity) });
    }
  }
  return out;
}

async function similarNames(name: string, excludeArtistId: string | null): Promise<SimilarName[]> {
  try {
    const { data, error } = await supabaseAdmin.rpc("similar_artist_names", {
      p_name: name,
      p_exclude_artist: excludeArtistId,
    });
    if (error) {
      if (!isMissingFunction(error)) console.error("similar_artist_names failed:", error.message);
      return [];
    }
    return toSimilarNames(data);
  } catch (err) {
    console.error("similar_artist_names failed:", (err as { message?: string })?.message ?? err);
    return [];
  }
}
