import { Router } from "express";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { requireAuth } from "../../middleware/auth";
import { requireCreator } from "../../middleware/requireCreator";
import { slugify, randomSuffix } from "../../lib/slugify";

export const creatorRouter = Router();

creatorRouter.use(requireAuth);

// Version affichée/acceptée des CGU créateur. Bumper cette valeur à chaque
// changement de texte pour forcer une nouvelle acceptation (non ré-enforcé
// automatiquement ici : un créateur déjà passé "creator" ne repasse pas par
// /apply, ce sera à traiter séparément si besoin).
const CREATOR_TERMS_VERSION = "2026-09-10";
const CONTENT_PROVENANCE_VALUES = new Set(["human", "ai", "hybrid"]);

// POST /creator/apply — passe le compte courant en rôle "creator" (self-serve,
// pas de validation manuelle pendant la bêta). Exige l'acceptation des CGU
// créateur et les réponses au questionnaire d'onboarding à chaque appel :
// c'est le seul point de passage listener → creator, donc le seul moment où
// ce consentement est capturé.
creatorRouter.post("/apply", async (req, res, next) => {
  try {
    const acceptedTerms = req.body?.accepted_terms;
    const contentProvenance = req.body?.content_provenance;
    const ownsRights = req.body?.owns_rights;
    const primaryGenre = req.body?.primary_genre;

    if (acceptedTerms !== true) {
      return res.status(400).json({ error: "You must accept the Creator Terms of Service" });
    }
    if (typeof contentProvenance !== "string" || !CONTENT_PROVENANCE_VALUES.has(contentProvenance)) {
      return res.status(400).json({ error: "content_provenance must be one of human, ai, hybrid" });
    }
    if (ownsRights !== true) {
      return res
        .status(400)
        .json({ error: "You must confirm you hold the rights to the content you'll upload" });
    }

    // Enregistré avant le changement de rôle : si ça échoue, le compte reste
    // listener plutôt que de finir creator sans questionnaire enregistré.
    const { error: onboardingError } = await supabaseAdmin.from("creator_onboarding").upsert(
      {
        user_id: req.auth!.id,
        terms_version: CREATOR_TERMS_VERSION,
        terms_accepted_at: new Date().toISOString(),
        content_provenance: contentProvenance,
        owns_rights: ownsRights,
        primary_genre:
          typeof primaryGenre === "string" && primaryGenre.trim() ? primaryGenre.trim() : null,
      },
      { onConflict: "user_id" }
    );
    if (onboardingError) throw onboardingError;

    const { data, error } = await supabaseAdmin
      .from("users")
      .update({ role: "creator" })
      .eq("id", req.auth!.id)
      .neq("role", "admin")
      .select("role")
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

creatorRouter.use(requireCreator);

// Résout l'artiste du créateur connecté. Un créateur possède au plus une
// page artiste dans cette version (pas de multi-artiste par compte).
async function myArtistId(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("artists")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

// GET /creator/artist — la page artiste du créateur connecté (ou null).
creatorRouter.get("/artist", async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("artists")
      .select("id, name, slug, bio, avatar_url, banner_url, country, verified")
      .eq("user_id", req.auth!.id)
      .maybeSingle();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /creator/artist — crée la page artiste (une seule par créateur).
creatorRouter.post("/artist", async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    if (name.length < 2) {
      return res.status(400).json({ error: "name must be at least 2 characters" });
    }

    const existingId = await myArtistId(req.auth!.id);
    if (existingId) return res.status(409).json({ error: "Artist profile already exists" });

    let slug = slugify(name);
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data, error } = await supabaseAdmin
        .from("artists")
        .insert({ user_id: req.auth!.id, name, slug })
        .select("id, name, slug, bio, avatar_url, banner_url, country, verified")
        .single();

      if (!error) return res.status(201).json(data);
      if (error.code !== "23505") throw error;
      slug = `${slugify(name)}-${randomSuffix()}`;
    }
    res.status(500).json({ error: "Could not allocate a unique slug" });
  } catch (err) {
    next(err);
  }
});

// PATCH /creator/artist — met à jour le profil public de l'artiste.
creatorRouter.patch("/artist", async (req, res, next) => {
  try {
    const artistId = await myArtistId(req.auth!.id);
    if (!artistId) return res.status(404).json({ error: "Artist profile not found" });

    const updates: Record<string, unknown> = {};
    for (const field of ["bio", "avatar_url", "banner_url", "country"] as const) {
      if (typeof req.body?.[field] === "string") updates[field] = req.body[field];
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    const { data, error } = await supabaseAdmin
      .from("artists")
      .update(updates)
      .eq("id", artistId)
      .select("id, name, slug, bio, avatar_url, banner_url, country, verified")
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

const ARTIST_IMAGE_BUCKET = "artist-images";
const ARTIST_IMAGE_KINDS = new Set(["avatar", "banner"]);

// POST /creator/artist/upload-url — URL signée pour uploader un avatar ou
// une bannière. Bucket public en lecture (contrairement à track-audio) :
// on renvoie directement l'URL publique déterministe, à sauvegarder ensuite
// via PATCH /creator/artist une fois l'upload terminé côté client.
creatorRouter.post("/artist/upload-url", async (req, res, next) => {
  try {
    const artistId = await myArtistId(req.auth!.id);
    if (!artistId) return res.status(404).json({ error: "Artist profile not found" });

    const kind = req.body?.kind;
    if (typeof kind !== "string" || !ARTIST_IMAGE_KINDS.has(kind)) {
      return res.status(400).json({ error: "kind must be one of: avatar, banner" });
    }

    const filename = String(req.body?.filename ?? "image");
    const ext = filename.includes(".") ? filename.split(".").pop() : "bin";
    const path = `${artistId}/${kind}-${Date.now()}.${ext}`;

    const { data, error } = await supabaseAdmin.storage
      .from(ARTIST_IMAGE_BUCKET)
      .createSignedUploadUrl(path);
    if (error) throw error;

    const {
      data: { publicUrl },
    } = supabaseAdmin.storage.from(ARTIST_IMAGE_BUCKET).getPublicUrl(path);

    res.json({ path, token: data.token, signedUrl: data.signedUrl, publicUrl });
  } catch (err) {
    next(err);
  }
});

// GET /creator/audience — nombre de followers + dates de follow brutes.
// L'agrégation par jour / la fenêtre glissante se font côté client : à ce
// stade (bêta) les volumes sont faibles, pas besoin d'une fonction SQL
// dédiée pour un GROUP BY que quelques lignes de JS suffisent à faire.
creatorRouter.get("/audience", async (req, res, next) => {
  try {
    const artistId = await myArtistId(req.auth!.id);
    if (!artistId) return res.json({ followers_count: 0, follows: [] });

    const { data, error } = await supabaseAdmin
      .from("follows")
      .select("created_at")
      .eq("artist_id", artistId)
      .order("created_at", { ascending: true });

    if (error) throw error;
    res.json({ followers_count: data.length, follows: data.map((f) => f.created_at) });
  } catch (err) {
    next(err);
  }
});

// GET /creator/albums — les releases du créateur, tous statuts confondus.
creatorRouter.get("/albums", async (req, res, next) => {
  try {
    const artistId = await myArtistId(req.auth!.id);
    if (!artistId) return res.json({ data: [] });

    const { data, error } = await supabaseAdmin
      .from("albums")
      .select("id, title, slug, type, cover_url, release_date, status, created_at")
      .eq("artist_id", artistId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

const ALBUM_TYPES = new Set(["album", "ep", "single", "compilation"]);

// POST /creator/albums — crée une release en brouillon.
creatorRouter.post("/albums", async (req, res, next) => {
  try {
    const artistId = await myArtistId(req.auth!.id);
    if (!artistId) return res.status(409).json({ error: "Create an artist profile first" });

    const title = String(req.body?.title ?? "").trim();
    if (title.length < 1) return res.status(400).json({ error: "title is required" });
    const type = ALBUM_TYPES.has(req.body?.type) ? req.body.type : "single";

    let slug = slugify(title);
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data, error } = await supabaseAdmin
        .from("albums")
        .insert({ artist_id: artistId, title, slug, type, status: "draft" })
        .select("id, title, slug, type, status, created_at")
        .single();

      if (!error) return res.status(201).json(data);
      if (error.code !== "23505") throw error;
      slug = `${slugify(title)}-${randomSuffix()}`;
    }
    res.status(500).json({ error: "Could not allocate a unique slug" });
  } catch (err) {
    next(err);
  }
});

// Vérifie que :id appartient bien au créateur connecté.
async function ownedAlbum(userId: string, albumId: string) {
  const artistId = await myArtistId(userId);
  if (!artistId) return null;

  const { data, error } = await supabaseAdmin
    .from("albums")
    .select("id, artist_id, title, slug, type, cover_url, release_date, status, created_at")
    .eq("id", albumId)
    .eq("artist_id", artistId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// GET /creator/albums/:id — release + ses morceaux.
creatorRouter.get("/albums/:id", async (req, res, next) => {
  try {
    const album = await ownedAlbum(req.auth!.id, req.params.id);
    if (!album) return res.status(404).json({ error: "Album not found" });

    const { data: tracks, error } = await supabaseAdmin
      .from("tracks")
      .select("id, title, status, track_number, duration_seconds")
      .eq("album_id", album.id)
      .order("track_number", { ascending: true });
    if (error) throw error;

    res.json({ ...album, tracks });
  } catch (err) {
    next(err);
  }
});

const ALBUM_EDITABLE_STATUSES = new Set(["draft", "in_review", "archived"]);

// PATCH /creator/albums/:id — métadonnées + transitions de statut limitées
// (mêmes règles que les morceaux : "published" reste réservé à l'admin).
creatorRouter.patch("/albums/:id", async (req, res, next) => {
  try {
    const album = await ownedAlbum(req.auth!.id, req.params.id);
    if (!album) return res.status(404).json({ error: "Album not found" });

    const updates: Record<string, unknown> = {};
    if (typeof req.body?.title === "string" && req.body.title.trim()) {
      updates.title = req.body.title.trim();
    }
    if (typeof req.body?.release_date === "string") updates.release_date = req.body.release_date;
    if (typeof req.body?.status === "string") {
      if (!ALBUM_EDITABLE_STATUSES.has(req.body.status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      updates.status = req.body.status;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    const { data, error } = await supabaseAdmin
      .from("albums")
      .update(updates)
      .eq("id", album.id)
      .select("id, title, slug, type, status, release_date, updated_at")
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// DELETE /creator/albums/:id — uniquement un brouillon ; détache ses
// morceaux plutôt que de les supprimer.
creatorRouter.delete("/albums/:id", async (req, res, next) => {
  try {
    const album = await ownedAlbum(req.auth!.id, req.params.id);
    if (!album) return res.status(404).json({ error: "Album not found" });
    if (album.status !== "draft") {
      return res.status(409).json({ error: "Only draft releases can be deleted" });
    }

    const { error: detachError } = await supabaseAdmin
      .from("tracks")
      .update({ album_id: null })
      .eq("album_id", album.id);
    if (detachError) throw detachError;

    const { error } = await supabaseAdmin.from("albums").delete().eq("id", album.id);
    if (error) throw error;
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// GET /creator/tracks — les morceaux du créateur, tous statuts confondus.
creatorRouter.get("/tracks", async (req, res, next) => {
  try {
    const artistId = await myArtistId(req.auth!.id);
    if (!artistId) return res.json({ data: [] });

    const { data, error } = await supabaseAdmin
      .from("tracks")
      .select(
        "id, title, slug, status, duration_seconds, explicit, album_id, created_at, published_at, albums(title, type)"
      )
      .eq("artist_id", artistId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// POST /creator/tracks — crée un morceau en brouillon.
creatorRouter.post("/tracks", async (req, res, next) => {
  try {
    const artistId = await myArtistId(req.auth!.id);
    if (!artistId) return res.status(409).json({ error: "Create an artist profile first" });

    const title = String(req.body?.title ?? "").trim();
    if (title.length < 1) return res.status(400).json({ error: "title is required" });
    const explicit = Boolean(req.body?.explicit);

    let slug = slugify(title);
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data, error } = await supabaseAdmin
        .from("tracks")
        .insert({ artist_id: artistId, title, slug, explicit, status: "draft" })
        .select("id, title, slug, status, explicit, created_at")
        .single();

      if (!error) return res.status(201).json(data);
      if (error.code !== "23505") throw error;
      slug = `${slugify(title)}-${randomSuffix()}`;
    }
    res.status(500).json({ error: "Could not allocate a unique slug" });
  } catch (err) {
    next(err);
  }
});

// Vérifie que :id appartient bien au créateur connecté.
async function ownedTrack(userId: string, trackId: string) {
  const artistId = await myArtistId(userId);
  if (!artistId) return null;

  const { data, error } = await supabaseAdmin
    .from("tracks")
    .select(
      "id, artist_id, title, slug, status, explicit, track_number, duration_seconds, album_id, created_at, published_at"
    )
    .eq("id", trackId)
    .eq("artist_id", artistId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// GET /creator/tracks/:id
creatorRouter.get("/tracks/:id", async (req, res, next) => {
  try {
    const track = await ownedTrack(req.auth!.id, req.params.id);
    if (!track) return res.status(404).json({ error: "Track not found" });

    const { data: files, error: filesError } = await supabaseAdmin
      .from("track_files")
      .select("id, format, quality_label, bitrate_kbps, file_size_bytes, created_at")
      .eq("track_id", track.id);
    if (filesError) throw filesError;

    res.json({ ...track, files });
  } catch (err) {
    next(err);
  }
});

// Statuts qu'un créateur peut choisir lui-même. "published" est exclu :
// réservé à la modération admin (hors périmètre de ce module).
const CREATOR_EDITABLE_STATUSES = new Set(["draft", "in_review", "archived"]);

// PATCH /creator/tracks/:id — métadonnées + transitions de statut limitées.
creatorRouter.patch("/tracks/:id", async (req, res, next) => {
  try {
    const track = await ownedTrack(req.auth!.id, req.params.id);
    if (!track) return res.status(404).json({ error: "Track not found" });

    const updates: Record<string, unknown> = {};
    if (typeof req.body?.title === "string" && req.body.title.trim()) {
      updates.title = req.body.title.trim();
    }
    if (typeof req.body?.explicit === "boolean") updates.explicit = req.body.explicit;
    if (typeof req.body?.track_number === "number") updates.track_number = req.body.track_number;
    if (typeof req.body?.status === "string") {
      if (!CREATOR_EDITABLE_STATUSES.has(req.body.status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      updates.status = req.body.status;
    }
    if (req.body?.album_id !== undefined) {
      if (req.body.album_id === null) {
        updates.album_id = null;
      } else if (typeof req.body.album_id === "string") {
        const album = await ownedAlbum(req.auth!.id, req.body.album_id);
        if (!album) return res.status(400).json({ error: "Invalid album_id" });
        updates.album_id = album.id;
      } else {
        return res.status(400).json({ error: "Invalid album_id" });
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    const { data, error } = await supabaseAdmin
      .from("tracks")
      .update(updates)
      .eq("id", track.id)
      .select("id, title, slug, status, explicit, track_number, album_id, updated_at")
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// DELETE /creator/tracks/:id — uniquement un brouillon jamais publié.
creatorRouter.delete("/tracks/:id", async (req, res, next) => {
  try {
    const track = await ownedTrack(req.auth!.id, req.params.id);
    if (!track) return res.status(404).json({ error: "Track not found" });
    if (track.status !== "draft") {
      return res.status(409).json({ error: "Only draft tracks can be deleted" });
    }

    const { error } = await supabaseAdmin.from("tracks").delete().eq("id", track.id);
    if (error) throw error;
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const PROVENANCE_VALUES = new Set(["human", "ai", "hybrid"]);

// GET /creator/tracks/:id/declaration — la déclaration de provenance IA la
// plus récente (l'historique est conservé, jamais écrasé — cf. schéma).
creatorRouter.get("/tracks/:id/declaration", async (req, res, next) => {
  try {
    const track = await ownedTrack(req.auth!.id, req.params.id);
    if (!track) return res.status(404).json({ error: "Track not found" });

    const { data, error } = await supabaseAdmin
      .from("ai_declarations")
      .select("id, provenance, ai_tool_names, description, status, declared_at")
      .eq("track_id", track.id)
      .order("declared_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /creator/tracks/:id/declaration — nouvelle déclaration (insert, pas
// d'update : chaque déclaration reste dans l'historique).
creatorRouter.post("/tracks/:id/declaration", async (req, res, next) => {
  try {
    const track = await ownedTrack(req.auth!.id, req.params.id);
    if (!track) return res.status(404).json({ error: "Track not found" });

    const provenance = req.body?.provenance;
    if (typeof provenance !== "string" || !PROVENANCE_VALUES.has(provenance)) {
      return res.status(400).json({ error: "provenance must be one of human, ai, hybrid" });
    }
    const description =
      typeof req.body?.description === "string" && req.body.description.trim()
        ? req.body.description.trim()
        : null;

    const { data, error } = await supabaseAdmin
      .from("ai_declarations")
      .insert({
        track_id: track.id,
        provenance,
        description,
        declared_by: req.auth!.id,
      })
      .select("id, provenance, ai_tool_names, description, status, declared_at")
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

const AUDIO_BUCKET = "track-audio";

// POST /creator/tracks/:id/upload-url — URL signée pour upload direct
// client → Supabase Storage : le fichier ne transite jamais par ce serveur.
creatorRouter.post("/tracks/:id/upload-url", async (req, res, next) => {
  try {
    const track = await ownedTrack(req.auth!.id, req.params.id);
    if (!track) return res.status(404).json({ error: "Track not found" });

    const filename = String(req.body?.filename ?? "audio");
    const ext = filename.includes(".") ? filename.split(".").pop() : "bin";
    const path = `${track.artist_id}/${track.id}/${Date.now()}.${ext}`;

    const { data, error } = await supabaseAdmin.storage.from(AUDIO_BUCKET).createSignedUploadUrl(path);
    if (error) throw error;

    res.json({ path, token: data.token, signedUrl: data.signedUrl });
  } catch (err) {
    next(err);
  }
});

// POST /creator/tracks/:id/files — enregistre le fichier une fois l'upload terminé.
creatorRouter.post("/tracks/:id/files", async (req, res, next) => {
  try {
    const track = await ownedTrack(req.auth!.id, req.params.id);
    if (!track) return res.status(404).json({ error: "Track not found" });

    const { path, format, file_size_bytes: fileSizeBytes } = req.body ?? {};
    if (typeof path !== "string" || !path.startsWith(`${track.artist_id}/${track.id}/`)) {
      return res.status(400).json({ error: "Invalid file path" });
    }

    const { data, error } = await supabaseAdmin
      .from("track_files")
      .insert({
        track_id: track.id,
        storage_provider: "supabase",
        storage_key: path,
        format: typeof format === "string" ? format : "unknown",
        file_size_bytes: typeof fileSizeBytes === "number" ? fileSizeBytes : null,
      })
      .select("id, format, file_size_bytes, created_at")
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

// DELETE /creator/tracks/:id/files/:fileId
creatorRouter.delete("/tracks/:id/files/:fileId", async (req, res, next) => {
  try {
    const track = await ownedTrack(req.auth!.id, req.params.id);
    if (!track) return res.status(404).json({ error: "Track not found" });

    const { data: file, error: fileError } = await supabaseAdmin
      .from("track_files")
      .select("id, storage_key")
      .eq("id", req.params.fileId)
      .eq("track_id", track.id)
      .maybeSingle();
    if (fileError) throw fileError;
    if (!file) return res.status(404).json({ error: "File not found" });

    await supabaseAdmin.storage.from(AUDIO_BUCKET).remove([file.storage_key]);

    const { error } = await supabaseAdmin.from("track_files").delete().eq("id", file.id);
    if (error) throw error;
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
