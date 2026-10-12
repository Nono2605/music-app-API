import { Router } from "express";
import { isUnchangedDeclaration } from "../../lib/declaration";
import {
  declarationProblem,
  isDeclarableProvenance,
  latestDeclarations,
  provenanceError,
  releaseDeclarationProblem,
} from "../../lib/provenance";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { requireAuth } from "../../middleware/auth";
import { requireCreator } from "../../middleware/requireCreator";
import { slugify, randomSuffix } from "../../lib/slugify";
import { probeAudioUrl, AudioProbeError, type AudioProbe, type AudioProbeFailure } from "../../lib/audioProbe";
import { syncTrackDuration } from "../../lib/syncTrackDuration";
import { myArtistId } from "../../lib/myArtistId";
import { trackReviewProblem, releaseReviewProblem } from "../../lib/reviewReadiness";
import { classifyArtistInsertError } from "../../lib/artistName";
import { checkArtistName } from "../../lib/artistNameCheck";
import { COVER_BUCKET, coverExtension, coverPath, ownCoverPath } from "../../lib/coverUrl";
import { creatorStatsRouter } from "./stats";

export const creatorRouter = Router();

creatorRouter.use(requireAuth);

// Version affichée/acceptée des CGU créateur. Bumper cette valeur à chaque
// changement de texte pour forcer une nouvelle acceptation (non ré-enforcé
// automatiquement ici : un créateur déjà passé "creator" ne repasse pas par
// /apply, ce sera à traiter séparément si besoin).
const CREATOR_TERMS_VERSION = "2026-09-10";

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
    if (!isDeclarableProvenance(contentProvenance)) {
      return res.status(400).json({ error: provenanceError("content_provenance", contentProvenance) });
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

// Statistiques de lecture : GET /creator/stats (voir stats.ts).
creatorRouter.use("/stats", creatorStatsRouter);

// GET /creator/artist — la page artiste du créateur connecté (ou null).
creatorRouter.get("/artist", async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("artists")
      .select("id, catalog_code, name, slug, bio, avatar_url, banner_url, country, verified")
      .eq("user_id", req.auth!.id)
      .maybeSingle();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /creator/artist — crée la page artiste (une seule par créateur).
//
// Le nom doit respecter les règles (lib/artistName.ts), ne pas être réservé et ne
// pas être déjà pris : sans tenir compte des accents, des majuscules ni de
// . - _ ' & !, donc « Rafale », « RAFALE » et « Rafalé! » sont le même nom.
// L'unicité est aussi imposée par la base : si deux créateurs réservent le même nom
// au même instant, le second reçoit la même réponse 409.
creatorRouter.post("/artist", async (req, res, next) => {
  try {
    const existingId = await myArtistId(req.auth!.id);
    if (existingId) return res.status(409).json({ error: "Artist profile already exists" });

    const check = await checkArtistName(req.body?.name);
    if (check.status === "invalid") {
      return res.status(400).json({ error: check.message, code: `name_${check.code}` });
    }
    if (check.status === "reserved") {
      return res.status(400).json({ error: check.message, code: "name_reserved" });
    }
    if (check.status === "taken") {
      return res.status(409).json(takenResponse(check.message, check.suggestions));
    }
    const name = check.name;

    let slug = slugify(name);
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data, error } = await supabaseAdmin
        .from("artists")
        .insert({ user_id: req.auth!.id, name, slug })
        .select("id, catalog_code, name, slug, bio, avatar_url, banner_url, country, verified")
        .single();

      if (!error) return res.status(201).json(data);

      switch (classifyArtistInsertError(error)) {
        case "name_taken":
          return res.status(409).json(takenResponse("This artist name is already taken.", []));
        case "already_has_artist":
          return res.status(409).json({ error: "Artist profile already exists" });
        case "name_reserved":
          return res.status(400).json({ error: "This name is reserved. Please choose another one.", code: "name_reserved" });
        case "name_format":
          return res.status(400).json({ error: "This name isn't valid.", code: "name_characters" });
        case "slug_taken":
          slug = `${slugify(name)}-${randomSuffix()}`;
          break;
        default:
          throw error;
      }
    }
    res.status(500).json({ error: "Could not allocate a unique slug" });
  } catch (err) {
    next(err);
  }
});

// Message de refus « nom pris » : les propositions sont dans le texte (le Studio
// affiche le message tel quel) et aussi, structurées, dans `suggestions`.
function takenResponse(message: string, suggestions: string[]) {
  const hint = suggestions.length > 0 ? ` Try: ${suggestions.join(", ")}.` : "";
  return { error: message + hint, code: "name_taken", suggestions };
}

// GET /creator/artist/name-check?name=… — ce nom est-il utilisable ? Sert à prévenir
// le créateur avant l'envoi du formulaire. Son propre nom compte comme libre.
creatorRouter.get("/artist/name-check", async (req, res, next) => {
  try {
    if (typeof req.query.name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }
    const check = await checkArtistName(req.query.name, await myArtistId(req.auth!.id));
    if (check.status === "ok") {
      return res.json({ available: true, name: check.name });
    }
    res.json({
      available: false,
      name: check.name,
      reason: check.status === "invalid" ? `name_${check.code}` : `name_${check.status}`,
      message: check.message,
      suggestions: check.status === "taken" ? check.suggestions : [],
    });
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
      .select("id, catalog_code, name, slug, bio, avatar_url, banner_url, country, verified")
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

// GET /creator/analytics — composition du catalogue (statuts, types de
// release, déclarations IA, durée). Pas de données d'écoute ici : ça
// demande d'instrumenter le lecteur (cf. Audience Phase 2), hors périmètre.
creatorRouter.get("/analytics", async (req, res, next) => {
  try {
    const artistId = await myArtistId(req.auth!.id);
    if (!artistId) {
      return res.json({
        tracks_by_status: {},
        releases_by_type: {},
        provenance_breakdown: { human: 0, ai: 0, hybrid: 0, undeclared: 0 },
        duration: { total_seconds: 0, average_seconds: 0, track_count: 0 },
        explicit_count: 0,
      });
    }

    const { data: tracks, error: tracksError } = await supabaseAdmin
      .from("tracks")
      .select("id, status, duration_seconds, explicit")
      .eq("artist_id", artistId);
    if (tracksError) throw tracksError;

    const { data: albums, error: albumsError } = await supabaseAdmin
      .from("albums")
      .select("type")
      .eq("artist_id", artistId);
    if (albumsError) throw albumsError;

    const trackIds = tracks.map((t) => t.id);
    let declarations: { track_id: string; provenance: string }[] = [];
    if (trackIds.length > 0) {
      const { data, error: declError } = await supabaseAdmin
        .from("ai_declarations")
        .select("track_id, provenance, declared_at")
        .in("track_id", trackIds)
        .order("declared_at", { ascending: false });
      if (declError) throw declError;
      declarations = data;
    }

    // La plus récente déclaration par morceau fait foi (historique conservé,
    // jamais écrasé — cf. schéma). declarations est déjà triée desc, donc la
    // première occurrence rencontrée par morceau est la bonne.
    const latestByTrack = new Map<string, string>();
    for (const d of declarations) {
      if (!latestByTrack.has(d.track_id)) latestByTrack.set(d.track_id, d.provenance);
    }

    const tracksByStatus: Record<string, number> = {};
    let totalDuration = 0;
    let durationCount = 0;
    let explicitCount = 0;
    const provenanceBreakdown: Record<string, number> = { human: 0, ai: 0, hybrid: 0, undeclared: 0 };

    for (const t of tracks) {
      tracksByStatus[t.status] = (tracksByStatus[t.status] ?? 0) + 1;
      if (typeof t.duration_seconds === "number") {
        totalDuration += t.duration_seconds;
        durationCount += 1;
      }
      if (t.explicit) explicitCount += 1;

      const provenance = latestByTrack.get(t.id);
      if (provenance === "human" || provenance === "ai" || provenance === "hybrid") {
        provenanceBreakdown[provenance] += 1;
      } else {
        provenanceBreakdown.undeclared += 1;
      }
    }

    const releasesByType: Record<string, number> = {};
    for (const a of albums) {
      releasesByType[a.type] = (releasesByType[a.type] ?? 0) + 1;
    }

    res.json({
      tracks_by_status: tracksByStatus,
      releases_by_type: releasesByType,
      provenance_breakdown: provenanceBreakdown,
      duration: {
        total_seconds: totalDuration,
        average_seconds: durationCount > 0 ? Math.round(totalDuration / durationCount) : 0,
        track_count: tracks.length,
      },
      explicit_count: explicitCount,
    });
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
      .select("id, catalog_code, title, slug, type, cover_url, release_date, status, created_at")
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
        .select("id, catalog_code, title, slug, type, status, created_at")
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
    .select("id, catalog_code, artist_id, title, slug, type, cover_url, release_date, status, created_at")
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
      .select("id, catalog_code, title, status, track_number, duration_seconds")
      .eq("album_id", album.id)
      .order("track_number", { ascending: true });
    if (error) throw error;

    res.json({ ...album, tracks });
  } catch (err) {
    next(err);
  }
});

// URL publique du dossier de l'artiste dans le bucket des pochettes (« / » final).
function coverPublicPrefix(artistId: string): string {
  return supabaseAdmin.storage.from(COVER_BUCKET).getPublicUrl(`${artistId}/`).data.publicUrl;
}

// POST /creator/albums/:id/cover-upload-url — URL signée pour envoyer la pochette d'une
// release directement dans le stockage. Le corps donne le type du fichier (`content_type`) ;
// la réponse contient l'URL publique à enregistrer ensuite avec PATCH /creator/albums/:id
// ({ cover_url }) une fois l'envoi terminé. Le stockage lui-même refuse tout autre type
// que JPEG / PNG / WebP et les fichiers de plus de 5 Mo.
creatorRouter.post("/albums/:id/cover-upload-url", async (req, res, next) => {
  try {
    const album = await ownedAlbum(req.auth!.id, req.params.id);
    if (!album) return res.status(404).json({ error: "Album not found" });

    const ext = coverExtension(req.body?.content_type);
    if (!ext) return res.status(400).json({ error: "The cover must be a JPEG, PNG or WebP image." });

    const path = coverPath(album.artist_id, album.id, ext, Date.now());
    const { data, error } = await supabaseAdmin.storage.from(COVER_BUCKET).createSignedUploadUrl(path);
    if (error) {
      // Migration 20261012000000_release_covers_storage.sql pas encore appliquée.
      if (/bucket not found/i.test(error.message)) {
        return res.status(503).json({ error: "Cover uploads aren't available yet. Try again shortly." });
      }
      throw error;
    }

    const {
      data: { publicUrl },
    } = supabaseAdmin.storage.from(COVER_BUCKET).getPublicUrl(path);

    res.json({ path, token: data.token, signedUrl: data.signedUrl, publicUrl });
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

    // Pochette : une URL de NOTRE bucket, dans le dossier de cet artiste, ou null pour la retirer.
    // Ancien fichier supprimé du stockage une fois la nouvelle valeur enregistrée.
    let staleCoverPath: string | null = null;
    if ("cover_url" in (req.body ?? {})) {
      const prefix = coverPublicPrefix(album.artist_id);
      if (req.body.cover_url === null) {
        updates.cover_url = null;
      } else if (ownCoverPath(req.body.cover_url, prefix, album.artist_id)) {
        updates.cover_url = req.body.cover_url;
      } else {
        return res.status(400).json({ error: "Invalid cover. Upload it again." });
      }
      if (updates.cover_url !== album.cover_url) {
        staleCoverPath = ownCoverPath(album.cover_url, prefix, album.artist_id);
      }
    }
    if (typeof req.body?.status === "string") {
      if (!ALBUM_EDITABLE_STATUSES.has(req.body.status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      // Une release part en relecture avec au moins un morceau, et de l'audio sur chacun.
      if (req.body.status === "in_review" && album.status !== "in_review") {
        const { data: albumTracks, error: tracksError } = await supabaseAdmin
          .from("tracks")
          .select("id, title")
          .eq("album_id", album.id);
        if (tracksError) throw tracksError;

        const trackIds = albumTracks.map((t) => t.id);
        let withAudio: string[] = [];
        if (trackIds.length > 0) {
          const { data: files, error: filesError } = await supabaseAdmin
            .from("track_files")
            .select("track_id")
            .in("track_id", trackIds);
          if (filesError) throw filesError;
          withAudio = files.map((f) => f.track_id);
        }
        const problem = releaseReviewProblem(albumTracks, withAudio);
        if (problem) return res.status(409).json({ error: problem });
        // Même règle que pour un morceau : chaque morceau doit être déclaré 100 % IA.
        const { data: declarations, error: declarationsError } = await supabaseAdmin
          .from("ai_declarations")
          .select("track_id, provenance, status, declared_at")
          .in("track_id", trackIds)
          .order("declared_at", { ascending: false });
        if (declarationsError) throw declarationsError;
        const declarationIssue = releaseDeclarationProblem(albumTracks, latestDeclarations(declarations ?? []));
        if (declarationIssue) return res.status(409).json({ error: declarationIssue });
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
      .select("id, catalog_code, title, slug, type, cover_url, status, release_date, updated_at")
      .single();

    if (error) throw error;

    // Best effort : un fichier qui reste n'est qu'un déchet de stockage, pas une erreur pour le créateur.
    if (staleCoverPath) {
      const { error: removeError } = await supabaseAdmin.storage.from(COVER_BUCKET).remove([staleCoverPath]);
      if (removeError) console.error("Could not remove previous cover:", removeError.message);
    }
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
        "id, catalog_code, title, slug, status, duration_seconds, explicit, track_number, album_id, created_at, published_at, albums(catalog_code, title, type)"
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
        .select("id, catalog_code, title, slug, status, explicit, created_at")
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
      "id, catalog_code, artist_id, title, slug, status, explicit, track_number, duration_seconds, album_id, created_at, published_at"
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
    // Position dans la release : un entier de 1 à 999 (la base l'impose aussi, >= 1).
    if (req.body?.track_number !== undefined) {
      const position = req.body.track_number;
      if (!Number.isInteger(position) || position < 1 || position > 999) {
        return res.status(400).json({ error: "track_number must be a whole number from 1 to 999" });
      }
      updates.track_number = position;
    }
    if (typeof req.body?.status === "string") {
      if (!CREATOR_EDITABLE_STATUSES.has(req.body.status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      // Un morceau publié (ou qui l'a été) a pu être écouté : on l'archive, on ne
      // le repasse pas en brouillon. Le trigger tracks_lifecycle l'impose aussi en
      // base ; ce contrôle donne une réponse claire plutôt qu'une erreur 500.
      const wasPublished = track.status === "published" || track.published_at !== null;
      if (wasPublished && req.body.status !== "archived") {
        return res.status(409).json({ error: "A track that was published can only be archived" });
      }
      // Rien à relire sans audio : on ne soumet pas un morceau vide à l'administration.
      if (req.body.status === "in_review" && track.status !== "in_review") {
        const { count, error: filesError } = await supabaseAdmin
          .from("track_files")
          .select("id", { count: "exact", head: true })
          .eq("track_id", track.id);
        if (filesError) throw filesError;
        const problem = trackReviewProblem(count ?? 0);
        if (problem) return res.status(409).json({ error: problem });
        // Bêta 100 % IA : un morceau déclaré hybrid (ou sans déclaration) reste enregistré mais ne part pas en relecture.
        const { data: latestDeclaration, error: declarationError } = await supabaseAdmin
          .from("ai_declarations")
          .select("provenance, status")
          .eq("track_id", track.id)
          .order("declared_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (declarationError) throw declarationError;
        const declarationIssue = declarationProblem(latestDeclaration);
        if (declarationIssue) return res.status(409).json({ error: declarationIssue });
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
      .select("id, catalog_code, title, slug, status, explicit, track_number, album_id, updated_at")
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
    // published_at : un brouillon ramené d'une publication antérieure a pu être
    // écouté, son historique d'écoute doit rester (aussi imposé par un trigger).
    if (track.status !== "draft" || track.published_at !== null) {
      return res.status(409).json({ error: "Only drafts that were never published can be deleted" });
    }

    const { error } = await supabaseAdmin.from("tracks").delete().eq("id", track.id);
    if (error) throw error;
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

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
    if (!isDeclarableProvenance(provenance)) {
      return res.status(400).json({ error: provenanceError("provenance", provenance) });
    }
    const description =
      typeof req.body?.description === "string" && req.body.description.trim()
        ? req.body.description.trim()
        : null;

    // Un « Save » répété sans rien changer ne crée pas de ligne : on renvoie la dernière
    // déclaration telle quelle (200). Voir lib/declaration.ts.
    const { data: latest, error: latestError } = await supabaseAdmin
      .from("ai_declarations")
      .select("id, provenance, ai_tool_names, description, status, declared_at")
      .eq("track_id", track.id)
      .order("declared_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestError) throw latestError;
    if (latest && isUnchangedDeclaration(latest, { provenance, description })) {
      return res.status(200).json(latest);
    }

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

    // L'extension vient du client : on ne garde qu'une extension plausible. Elle
    // n'a aucun rôle dans la détection du format (faite sur le contenu).
    const filename = String(req.body?.filename ?? "audio");
    const rawExt = filename.includes(".") ? (filename.split(".").pop() ?? "").toLowerCase() : "";
    const ext = /^[a-z0-9]{1,5}$/.test(rawExt) ? rawExt : "bin";
    const path = `${track.artist_id}/${track.id}/${Date.now()}.${ext}`;

    const { data, error } = await supabaseAdmin.storage.from(AUDIO_BUCKET).createSignedUploadUrl(path);
    if (error) throw error;

    res.json({ path, token: data.token, signedUrl: data.signedUrl });
  } catch (err) {
    next(err);
  }
});

const PROBE_STATUS: Record<AudioProbeFailure, number> = {
  not_found: 400,
  unreachable: 502,
  too_large: 413,
  not_audio: 422,
  unsupported: 415,
  no_duration: 422,
};

// POST /creator/tracks/:id/files — enregistre le fichier une fois l'upload
// terminé. Le client envoie le fichier directement au stockage ; le serveur le
// relit ici pour le MESURER : format réel, durée, débit, taille, empreinte.
// Ce que le client déclare (format, taille) est ignoré, et la durée du morceau
// est mise à jour depuis la mesure.
creatorRouter.post("/tracks/:id/files", async (req, res, next) => {
  try {
    const track = await ownedTrack(req.auth!.id, req.params.id);
    if (!track) return res.status(404).json({ error: "Track not found" });

    // Exactement la forme produite par /upload-url : un chemin libre (« ../ »)
    // pourrait viser le fichier privé d'un autre artiste.
    const path = req.body?.path;
    const expectedPath = new RegExp(`^${track.artist_id}/${track.id}/\\d+\\.[a-z0-9]{1,5}$`);
    if (typeof path !== "string" || !expectedPath.test(path)) {
      return res.status(400).json({ error: "Invalid file path" });
    }

    const { data: alreadyAttached, error: alreadyError } = await supabaseAdmin
      .from("track_files")
      .select("id")
      .eq("track_id", track.id)
      .eq("storage_key", path)
      .limit(1)
      .maybeSingle();
    if (alreadyError) throw alreadyError;
    if (alreadyAttached) return res.status(409).json({ error: "This file is already attached to the track" });

    const { data: signed, error: signError } = await supabaseAdmin.storage
      .from(AUDIO_BUCKET)
      .createSignedUrl(path, 300);
    if (signError || !signed) return res.status(400).json({ error: "The uploaded file could not be found" });

    let probe: AudioProbe;
    try {
      probe = await probeAudioUrl(signed.signedUrl);
    } catch (err) {
      if (!(err instanceof AudioProbeError)) throw err;
      // Fichier inutilisable : on retire l'objet plutôt que de laisser un orphelin.
      if (err.reason !== "unreachable" && err.reason !== "not_found") {
        await supabaseAdmin.storage.from(AUDIO_BUCKET).remove([path]);
      }
      return res.status(PROBE_STATUS[err.reason]).json({ error: err.message });
    }

    // Même contenu déjà attaché à ce morceau (réupload du même fichier).
    const { data: duplicate, error: duplicateError } = await supabaseAdmin
      .from("track_files")
      .select("id")
      .eq("track_id", track.id)
      .eq("checksum", probe.sha256)
      .limit(1)
      .maybeSingle();
    if (duplicateError) throw duplicateError;
    if (duplicate) {
      await supabaseAdmin.storage.from(AUDIO_BUCKET).remove([path]);
      return res.status(409).json({ error: "This exact file is already attached to the track" });
    }

    const { data, error } = await supabaseAdmin
      .from("track_files")
      .insert({
        track_id: track.id,
        storage_provider: "supabase",
        storage_key: path,
        format: probe.format,
        file_size_bytes: probe.sizeBytes,
        bitrate_kbps: probe.bitrateKbps,
        checksum: probe.sha256,
        duration_seconds: probe.durationSeconds,
        verified_at: new Date().toISOString(),
      })
      .select("id, format, file_size_bytes, bitrate_kbps, duration_seconds, created_at")
      .single();
    if (error) throw error;

    await syncTrackDuration(track.id);
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

    // Un morceau publié garde toujours au moins un fichier : sans lui,
    // GET /tracks/:id/stream répondrait 404 à ses auditeurs.
    if (track.status === "published") {
      const { count, error: countError } = await supabaseAdmin
        .from("track_files")
        .select("id", { count: "exact", head: true })
        .eq("track_id", track.id);
      if (countError) throw countError;
      if ((count ?? 0) <= 1) {
        return res.status(409).json({ error: "A published track must keep an audio file" });
      }
    }

    await supabaseAdmin.storage.from(AUDIO_BUCKET).remove([file.storage_key]);

    const { error } = await supabaseAdmin.from("track_files").delete().eq("id", file.id);
    if (error) throw error;

    await syncTrackDuration(track.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
