import { Router } from "express";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { requireAuth } from "../../middleware/auth";
import { loadAlbumProvenance, loadTrackProvenance } from "../../lib/loadProvenance";
import { loadExplicitAlbums } from "../../lib/loadExplicit";
import { loadTrackMeta } from "../../lib/loadTrackMeta";
import { loadTrackLikeCounts } from "../../lib/loadLikeCounts";
import { metaFields } from "../../lib/trackMeta";
import { chunk } from "../../lib/publicProvenance";
import { ITEM_TYPES, MAX_IDS, parseItem, parseLibraryParams, playlistVisibleTo, type ItemType } from "./page";

export const libraryRouter = Router();

// Les identifiants vont dans l'URL de la requête (in.(…)) : une liste longue la ferait dépasser la
// limite. On interroge par lots de cette taille.
const DETAIL_BATCH = 100;

const DETAIL_QUERIES: Record<ItemType, { table: string; select: string }> = {
  track: { table: "tracks", select: "id, title, slug, duration_seconds, explicit, artists(name), albums(cover_url)" },
  album: { table: "albums", select: "id, title, cover_url, artists(name, slug)" },
  artist: { table: "artists", select: "id, name, slug, avatar_url, verified" },
  playlist: { table: "playlists", select: "id, title, cover_url, owner_id, is_public" },
};

// Un morceau ou un album retiré du catalogue (refusé, archivé) ne s'affiche plus dans la
// bibliothèque : la ligne reste en base, et revient s'il est republié.
const PUBLISHED_ONLY = new Set<ItemType>(["track", "album"]);

type Item = Record<string, unknown>;

async function loadDetails(type: ItemType, ids: readonly string[], userId: string): Promise<Map<string, Item>> {
  const { table, select } = DETAIL_QUERIES[type];
  const batches = await Promise.all(
    chunk([...new Set(ids)], DETAIL_BATCH).map(async (batch) => {
      let query = supabaseAdmin.from(table).select(select).in("id", batch);
      if (PUBLISHED_ONLY.has(type)) query = query.eq("status", "published");
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as unknown as Item[];
    })
  );

  const details = new Map<string, Item>();
  for (const item of batches.flat()) {
    if (type === "playlist") {
      // Une playlist devenue privée disparaît des favoris des autres ; le propriétaire n'est jamais exposé.
      if (!playlistVisibleTo(userId, item)) continue;
      delete item.owner_id;
    }
    details.set(item.id as string, item);
  }
  return details;
}

// GET /library — ce que l'utilisateur a sauvegardé, le plus récent d'abord, avec le détail de
// chaque élément (les tables cibles diffèrent selon item_type, donc une requête groupée par type
// plutôt qu'une jointure unique). Paginé : ?limit= (100 au plus), ?offset=, et ?type= pour ne
// lire qu'une famille (track, album, artist, playlist).
// Un élément qui n'est plus disponible (morceau retiré, playlist devenue privée) a `item: null`.
libraryRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const params = parseLibraryParams(req.query);
    if (!params) return res.status(400).json({ error: `type must be one of: ${ITEM_TYPES.join(", ")}` });
    const userId = req.auth!.id;

    let rowsQuery = supabaseAdmin
      .from("library")
      .select("id, item_type, item_id, added_at")
      .eq("user_id", userId);
    if (params.type) rowsQuery = rowsQuery.eq("item_type", params.type);

    const { data: rows, error } = await rowsQuery
      .order("added_at", { ascending: false })
      .range(params.offset, params.offset + params.limit - 1);
    if (error) throw error;

    const idsByType: Record<ItemType, string[]> = { track: [], album: [], artist: [], playlist: [] };
    for (const row of rows) idsByType[row.item_type as ItemType].push(row.item_id);

    const detailsByType: Partial<Record<ItemType, Map<string, Item>>> = {};
    await Promise.all(
      ITEM_TYPES.map(async (type) => {
        if (idsByType[type].length > 0) detailsByType[type] = await loadDetails(type, idsByType[type], userId);
      })
    );

    // Badges de provenance IA et « E » (explicite) des morceaux et des albums de cette page.
    const [trackProvenance, albumProvenance, explicitAlbums, trackMeta, trackLikes] = await Promise.all([
      loadTrackProvenance(idsByType.track),
      loadAlbumProvenance(idsByType.album),
      loadExplicitAlbums(idsByType.album),
      loadTrackMeta(idsByType.track),
      loadTrackLikeCounts(idsByType.track),
    ]);
    for (const [id, item] of detailsByType.track ?? []) {
      item.provenance = trackProvenance.get(id) ?? null;
      item.likes_count = trackLikes.get(id) ?? 0;
      Object.assign(item, metaFields(trackMeta.get(id))); // genres, styles et crédits
    }
    for (const [id, item] of detailsByType.album ?? []) {
      item.provenance = albumProvenance.get(id) ?? null;
      item.explicit = explicitAlbums.has(id);
    }

    const result = rows.map((row) => ({
      id: row.id,
      item_type: row.item_type,
      added_at: row.added_at,
      item: detailsByType[row.item_type as ItemType]?.get(row.item_id) ?? null,
    }));

    res.json({ data: result, limit: params.limit, offset: params.offset });
  } catch (err) {
    next(err);
  }
});

// GET /library/ids?type=track — les seuls identifiants sauvegardés d'un type, sans détail : de quoi
// colorer les cœurs d'une page en une requête de quelques Ko, quelle que soit la taille de la
// bibliothèque (jusqu'à MAX_IDS identifiants, les plus récents).
libraryRouter.get("/ids", requireAuth, async (req, res, next) => {
  try {
    const params = parseLibraryParams(req.query);
    if (!params?.type) return res.status(400).json({ error: `type must be one of: ${ITEM_TYPES.join(", ")}` });

    const { data, error } = await supabaseAdmin
      .from("library")
      .select("item_id")
      .eq("user_id", req.auth!.id)
      .eq("item_type", params.type)
      .order("added_at", { ascending: false })
      .range(0, MAX_IDS - 1);
    if (error) throw error;

    res.json({ ids: data.map((row) => row.item_id) });
  } catch (err) {
    next(err);
  }
});

// GET /library/:itemType/:itemId — l'utilisateur a-t-il déjà sauvegardé cet élément ?
libraryRouter.get("/:itemType/:itemId", requireAuth, async (req, res, next) => {
  try {
    const item = parseItem(req.params.itemType, req.params.itemId);
    if (!item) return res.status(400).json({ error: `item_type must be one of: ${ITEM_TYPES.join(", ")}, and item_id a UUID` });

    const { data, error } = await supabaseAdmin
      .from("library")
      .select("id")
      .eq("user_id", req.auth!.id)
      .eq("item_type", item.type)
      .eq("item_id", item.id)
      .maybeSingle();

    if (error) throw error;
    res.json({ saved: !!data });
  } catch (err) {
    next(err);
  }
});

// POST /library/:itemType/:itemId
libraryRouter.post("/:itemType/:itemId", requireAuth, async (req, res, next) => {
  try {
    const item = parseItem(req.params.itemType, req.params.itemId);
    if (!item) return res.status(400).json({ error: `item_type must be one of: ${ITEM_TYPES.join(", ")}, and item_id a UUID` });

    const { error } = await supabaseAdmin
      .from("library")
      .insert({ user_id: req.auth!.id, item_type: item.type, item_id: item.id });

    if (error && error.code !== "23505") throw error;
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// DELETE /library/:itemType/:itemId
libraryRouter.delete("/:itemType/:itemId", requireAuth, async (req, res, next) => {
  try {
    const item = parseItem(req.params.itemType, req.params.itemId);
    if (!item) return res.status(400).json({ error: `item_type must be one of: ${ITEM_TYPES.join(", ")}, and item_id a UUID` });

    const { error } = await supabaseAdmin
      .from("library")
      .delete()
      .eq("user_id", req.auth!.id)
      .eq("item_type", item.type)
      .eq("item_id", item.id);

    if (error) throw error;
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
