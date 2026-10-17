import { Router } from "express";
import { GenresUnavailableError, listGenres } from "../../lib/genres";
import { myArtistId } from "../../lib/myArtistId";
import { isDeclarableProvenance, provenanceError } from "../../lib/provenance";
import {
  joinGenres,
  parseCredits,
  parseGenres,
  parseReleaseDetails,
  parseTags,
  splitGenres,
  type CreditInput,
} from "../../lib/releaseMeta";
import { isMissingColumn, isMissingFunction, isMissingTable } from "../../lib/schemaCompat";
import { randomSuffix, slugify } from "../../lib/slugify";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { requireAuth } from "../../middleware/auth";
import { requireCreator } from "../../middleware/requireCreator";
import { containsPattern } from "../albums/list";

// Détails d'un morceau et d'une release (migration 20261018000000_release_details.sql) : plusieurs genres,
// styles libres, artistes invités et crédits ; description, label, copyright, date de sortie ; et la création
// d'un morceau directement dans une release avec tout ça (l'assistant « nouvelle release » du Studio).
// Un routeur à part, monté sur /creator avant le routeur principal : chaque route porte ses contrôles d'accès.
//
// Avant la migration, les routes qui écrivent répondent 503 « pas encore disponible » ; celles qui lisent
// répondent `available: false` pour que le Studio garde ses écrans d'avant.
export const creatorDetailsRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailable = { error: "Release details are not available yet", code: "details_unavailable" };

class DetailsUnavailableError extends Error {}

// Une colonne, une table ou une fonction de la migration manque : on le dit proprement.
function isMissingSchema(error: unknown): boolean {
  return isMissingColumn(error) || isMissingTable(error) || isMissingFunction(error);
}

async function ownedTrackRow(userId: string, trackId: string): Promise<{ id: string; artist_id: string } | null> {
  if (!UUID.test(trackId)) return null;
  const artistId = await myArtistId(userId);
  if (!artistId) return null;
  const { data, error } = await supabaseAdmin
    .from("tracks")
    .select("id, artist_id")
    .eq("id", trackId)
    .eq("artist_id", artistId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function ownedAlbumRow(
  userId: string,
  albumId: string
): Promise<{ id: string; artist_id: string; status: string } | null> {
  if (!UUID.test(albumId)) return null;
  const artistId = await myArtistId(userId);
  if (!artistId) return null;
  const { data, error } = await supabaseAdmin
    .from("albums")
    .select("id, artist_id, status")
    .eq("id", albumId)
    .eq("artist_id", artistId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Chaque code de genre doit exister et être actif (la liste fermée de l'API).
async function unknownGenre(codes: string[]): Promise<string | null> {
  if (codes.length === 0) return null;
  const active = new Set((await listGenres()).map((genre) => genre.code));
  const unknown = codes.find((code) => !active.has(code));
  return unknown ? `Unknown genre: ${unknown}` : null;
}

// Les artistes liés existent, ont un nom accepté et ne sont pas anonymisés ; ce n'est pas l'artiste du morceau
// lui-même. Le nom affiché d'un crédit lié est TOUJOURS le nom en base : le client ne choisit pas le nom
// sous lequel il crédite un autre artiste.
async function resolveCredits(
  credits: CreditInput[],
  ownArtistId: string
): Promise<{ ok: true; value: CreditInput[] } | { ok: false; error: string }> {
  const ids = [...new Set(credits.map((credit) => credit.artist_id).filter((id): id is string => !!id))];
  if (ids.includes(ownArtistId)) {
    return { ok: false, error: "You can't credit your own artist page: the track already carries your name." };
  }
  if (ids.length === 0) return { ok: true, value: credits };

  const run = (approvedOnly: boolean) => {
    let query = supabaseAdmin.from("artists").select("id, name").in("id", ids).is("anonymized_at", null);
    if (approvedOnly) query = query.eq("name_status", "approved");
    return query;
  };
  let { data, error } = await run(true);
  if (error && isMissingColumn(error)) ({ data, error } = await run(false));
  if (error) throw error;

  const names = new Map((data ?? []).map((artist) => [String(artist.id), String(artist.name)]));
  if (names.size !== ids.length) {
    return { ok: false, error: "A credited artist can't be found. Search again and pick them from the list." };
  }
  return {
    ok: true,
    value: credits.map((credit) => (credit.artist_id ? { ...credit, name: names.get(credit.artist_id) ?? credit.name } : credit)),
  };
}

interface TrackDetails {
  available: boolean;
  genres: string[];
  tags: string[];
  credits: { role: string; artist_id: string | null; name: string }[];
}

async function readTrackDetails(trackId: string): Promise<TrackDetails> {
  const full = await supabaseAdmin
    .from("tracks")
    .select("genre_code, extra_genre_codes, tags")
    .eq("id", trackId)
    .maybeSingle();
  if (full.error) {
    if (!isMissingColumn(full.error)) throw full.error;
    // Avant la migration : seulement le genre principal, et rien d'autre.
    const legacy = await supabaseAdmin.from("tracks").select("genre_code").eq("id", trackId).maybeSingle();
    if (legacy.error && !isMissingColumn(legacy.error)) throw legacy.error;
    return { available: false, genres: joinGenres(legacy.data?.genre_code, null), tags: [], credits: [] };
  }

  const credits = await supabaseAdmin
    .from("track_credits")
    .select("role, artist_id, display_name, position")
    .eq("track_id", trackId)
    .order("position", { ascending: true });
  if (credits.error && !isMissingSchema(credits.error)) throw credits.error;
  if (credits.error) {
    return { available: false, genres: joinGenres(full.data?.genre_code, full.data?.extra_genre_codes), tags: [], credits: [] };
  }

  return {
    available: true,
    genres: joinGenres(full.data?.genre_code, full.data?.extra_genre_codes),
    tags: Array.isArray(full.data?.tags) ? (full.data.tags as string[]) : [],
    credits: (credits.data ?? []).map((row) => ({
      role: String(row.role),
      artist_id: typeof row.artist_id === "string" ? row.artist_id : null,
      name: String(row.display_name),
    })),
  };
}

interface DetailsChange {
  genres?: string[];
  tags?: string[];
  credits?: CreditInput[];
}

// Lit et vérifie ce que le client envoie ; une partie absente reste inchangée.
async function parseDetailsChange(
  body: Record<string, unknown>,
  ownArtistId: string
): Promise<{ ok: true; value: DetailsChange } | { ok: false; error: string }> {
  const change: DetailsChange = {};

  if (body.genres !== undefined) {
    const genres = parseGenres(body.genres);
    if (!genres.ok) return genres;
    const unknown = await unknownGenre(genres.value);
    if (unknown) return { ok: false, error: unknown };
    change.genres = genres.value;
  }
  if (body.tags !== undefined) {
    const tags = parseTags(body.tags);
    if (!tags.ok) return tags;
    change.tags = tags.value;
  }
  if (body.credits !== undefined) {
    const parsed = parseCredits(body.credits);
    if (!parsed.ok) return parsed;
    const resolved = await resolveCredits(parsed.value, ownArtistId);
    if (!resolved.ok) return resolved;
    change.credits = resolved.value;
  }
  return { ok: true, value: change };
}

// Les colonnes de `tracks` que ce changement modifie.
function trackColumns(change: DetailsChange): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  if (change.genres !== undefined) {
    const { main, extras } = splitGenres(change.genres);
    columns.genre_code = main;
    columns.extra_genre_codes = extras;
  }
  if (change.tags !== undefined) columns.tags = change.tags;
  return columns;
}

async function replaceCredits(trackId: string, credits: CreditInput[]): Promise<void> {
  const { error } = await supabaseAdmin.rpc("replace_track_credits", { p_track_id: trackId, p_credits: credits });
  if (error) {
    if (isMissingSchema(error)) throw new DetailsUnavailableError("track_credits is missing");
    throw error;
  }
}

// GET /creator/tracks/:id/details → { available, genres (le principal d'abord), tags, credits }
creatorDetailsRouter.get("/tracks/:id/details", requireAuth, requireCreator, async (req, res, next) => {
  try {
    if (!(await ownedTrackRow(req.auth!.id, req.params.id))) return res.status(404).json({ error: "Track not found" });
    res.json(await readTrackDetails(req.params.id));
  } catch (err) {
    next(err);
  }
});

// PUT /creator/tracks/:id/details  { genres?, tags?, credits? } — une partie absente reste inchangée ; un
// tableau vide efface. Le premier genre devient le genre principal.
creatorDetailsRouter.put("/tracks/:id/details", requireAuth, requireCreator, async (req, res, next) => {
  try {
    const track = await ownedTrackRow(req.auth!.id, req.params.id);
    if (!track) return res.status(404).json({ error: "Track not found" });

    const change = await parseDetailsChange(req.body ?? {}, track.artist_id);
    if (!change.ok) return res.status(400).json({ error: change.error });

    const columns = trackColumns(change.value);
    if (Object.keys(columns).length > 0) {
      const { error } = await supabaseAdmin.from("tracks").update(columns).eq("id", track.id);
      if (error) {
        if (isMissingSchema(error)) return res.status(503).json(unavailable);
        throw error;
      }
    }
    if (change.value.credits !== undefined) await replaceCredits(track.id, change.value.credits);

    res.json(await readTrackDetails(track.id));
  } catch (err) {
    if (err instanceof DetailsUnavailableError || err instanceof GenresUnavailableError) {
      return res.status(503).json(unavailable);
    }
    next(err);
  }
});

// POST /creator/albums/:id/tracks — crée un morceau directement dans une release en brouillon, avec ses
// détails et sa déclaration IA, en une seule demande :
//   { title, explicit?, position?, genres?, tags?, credits?, provenance?, declaration_note? }
// `position` (1 à 999) est la place du morceau dans la release : la base respecte une position donnée à la
// création, ce qui garde l'ordre choisi même si un morceau est créé après les autres (nouvel essai).
// Tout est vérifié AVANT de créer quoi que ce soit ; si une étape échoue après la création du morceau, il est
// supprimé (un brouillon sans fichier se supprime) : pas de morceau à moitié rempli. Le fichier audio, lui, part
// ensuite du navigateur vers le stockage, comme pour un morceau créé seul.
creatorDetailsRouter.post("/albums/:id/tracks", requireAuth, requireCreator, async (req, res, next) => {
  try {
    const album = await ownedAlbumRow(req.auth!.id, req.params.id);
    if (!album) return res.status(404).json({ error: "Album not found" });
    if (album.status !== "draft") {
      return res.status(409).json({ error: "Withdraw the release to draft before adding tracks to it." });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (title.length < 1) return res.status(400).json({ error: "title is required" });
    if (title.length > 200) return res.status(400).json({ error: "The title can have up to 200 characters." });
    const explicit = Boolean(body.explicit);

    let position: number | null = null;
    if (body.position !== undefined && body.position !== null) {
      if (!Number.isInteger(body.position) || (body.position as number) < 1 || (body.position as number) > 999) {
        return res.status(400).json({ error: "position must be a whole number from 1 to 999" });
      }
      position = body.position as number;
    }

    let provenance: string | null = null;
    if (body.provenance !== undefined && body.provenance !== null) {
      if (!isDeclarableProvenance(body.provenance)) {
        return res.status(400).json({ error: provenanceError("provenance", body.provenance) });
      }
      provenance = body.provenance;
    }
    const note =
      typeof body.declaration_note === "string" && body.declaration_note.trim() ? body.declaration_note.trim() : null;

    const change = await parseDetailsChange(body, album.artist_id);
    if (!change.ok) return res.status(400).json({ error: change.error });

    const columns = trackColumns(change.value);
    let slug = slugify(title);
    let created: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      const { data, error } = await supabaseAdmin
        .from("tracks")
        .insert({
          artist_id: album.artist_id,
          album_id: album.id,
          title,
          slug,
          explicit,
          status: "draft",
          ...(position ? { track_number: position } : {}),
          ...columns,
        })
        .select("id, catalog_code, title, slug, status, explicit, track_number, album_id, created_at")
        .single();
      if (!error) {
        created = data;
        break;
      }
      if (isMissingSchema(error)) return res.status(503).json(unavailable);
      if (error.code !== "23505") throw error;
      slug = `${slugify(title)}-${randomSuffix()}`;
    }
    if (!created) return res.status(500).json({ error: "Could not allocate a unique slug" });
    const trackId = String(created.id);

    try {
      if (change.value.credits && change.value.credits.length > 0) await replaceCredits(trackId, change.value.credits);
      if (provenance) {
        const { error } = await supabaseAdmin
          .from("ai_declarations")
          .insert({ track_id: trackId, provenance, description: note, declared_by: req.auth!.id });
        if (error) throw error;
      }
    } catch (stepError) {
      const { error: cleanupError } = await supabaseAdmin.from("tracks").delete().eq("id", trackId);
      if (cleanupError) console.error("Could not remove the incomplete track:", cleanupError.message);
      throw stepError;
    }

    res.status(201).json(created);
  } catch (err) {
    if (err instanceof DetailsUnavailableError || err instanceof GenresUnavailableError) {
      return res.status(503).json(unavailable);
    }
    next(err);
  }
});

// GET /creator/artists/search?q=… — des artistes Vynl à créditer (nom accepté, compte non supprimé, pas soi-même).
// Que des noms et des photos publics ; au plus 8 résultats.
creatorDetailsRouter.get("/artists/search", requireAuth, requireCreator, async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 2) return res.json({ data: [] });

    const ownArtistId = await myArtistId(req.auth!.id);
    const run = (approvedOnly: boolean) => {
      let query = supabaseAdmin
        .from("artists")
        .select("id, name, slug, avatar_url")
        .is("anonymized_at", null)
        .ilike("name", containsPattern(q.slice(0, 60)));
      if (approvedOnly) query = query.eq("name_status", "approved");
      if (ownArtistId) query = query.neq("id", ownArtistId);
      return query.order("name", { ascending: true }).limit(8);
    };
    let { data, error } = await run(true);
    if (error && isMissingColumn(error)) ({ data, error } = await run(false));
    if (error) throw error;
    res.json({ data: data ?? [] });
  } catch (err) {
    next(err);
  }
});

const RELEASE_DETAIL_COLUMNS = "description, label, copyright_line, release_date";

// GET /creator/albums/:id/details → { available, description, label, copyright_line, release_date }
creatorDetailsRouter.get("/albums/:id/details", requireAuth, requireCreator, async (req, res, next) => {
  try {
    const album = await ownedAlbumRow(req.auth!.id, req.params.id);
    if (!album) return res.status(404).json({ error: "Album not found" });

    const { data, error } = await supabaseAdmin.from("albums").select(RELEASE_DETAIL_COLUMNS).eq("id", album.id).maybeSingle();
    if (error) {
      if (!isMissingColumn(error)) throw error;
      const legacy = await supabaseAdmin.from("albums").select("release_date").eq("id", album.id).maybeSingle();
      if (legacy.error) throw legacy.error;
      return res.json({ available: false, description: null, label: null, copyright_line: null, release_date: legacy.data?.release_date ?? null });
    }
    res.json({
      available: true,
      description: data?.description ?? null,
      label: data?.label ?? null,
      copyright_line: data?.copyright_line ?? null,
      release_date: data?.release_date ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /creator/albums/:id/details  { description?, label?, copyright_line?, release_date? } — un champ absent reste
// inchangé, vide ou null l'efface. Tout est facultatif : rien de ceci n'est exigé pour soumettre une release.
creatorDetailsRouter.put("/albums/:id/details", requireAuth, requireCreator, async (req, res, next) => {
  try {
    const album = await ownedAlbumRow(req.auth!.id, req.params.id);
    if (!album) return res.status(404).json({ error: "Album not found" });

    const details = parseReleaseDetails(req.body ?? {});
    if (!details.ok) return res.status(400).json({ error: details.error });
    if (Object.keys(details.value).length === 0) return res.status(400).json({ error: "No valid fields to update" });

    const { data, error } = await supabaseAdmin
      .from("albums")
      .update(details.value)
      .eq("id", album.id)
      .select(RELEASE_DETAIL_COLUMNS)
      .single();
    if (error) {
      if (isMissingColumn(error)) return res.status(503).json(unavailable);
      throw error;
    }
    res.json({ available: true, ...data });
  } catch (err) {
    next(err);
  }
});
