import { Router } from "express";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { requireAuth } from "../../middleware/auth";

export const libraryRouter = Router();

const ITEM_TYPES = ["track", "album", "artist", "playlist"] as const;
type ItemType = (typeof ITEM_TYPES)[number];

const DETAIL_QUERIES: Record<ItemType, { table: string; select: string }> = {
  track: { table: "tracks", select: "id, title, slug, duration_seconds, artists(name), albums(cover_url)" },
  album: { table: "albums", select: "id, title, cover_url, artists(name, slug)" },
  artist: { table: "artists", select: "id, name, slug, avatar_url, verified" },
  playlist: { table: "playlists", select: "id, title, cover_url" },
};

// GET /library — tout ce que l'utilisateur a sauvegardé, avec le détail de
// chaque élément (les tables cibles diffèrent selon item_type, donc une
// requête groupée par type plutôt qu'une jointure unique).
libraryRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const { data: rows, error } = await supabaseAdmin
      .from("library")
      .select("id, item_type, item_id, added_at")
      .eq("user_id", req.auth!.id)
      .order("added_at", { ascending: false });

    if (error) throw error;

    const idsByType: Record<ItemType, string[]> = { track: [], album: [], artist: [], playlist: [] };
    for (const row of rows) idsByType[row.item_type as ItemType].push(row.item_id);

    const detailsByType: Record<string, Record<string, unknown>> = {};
    for (const type of ITEM_TYPES) {
      const ids = idsByType[type];
      if (ids.length === 0) continue;
      const { table, select } = DETAIL_QUERIES[type];
      const { data, error: detailError } = await supabaseAdmin.from(table).select(select).in("id", ids);
      if (detailError) throw detailError;
      detailsByType[type] = Object.fromEntries((data ?? []).map((item: any) => [item.id, item]));
    }

    const result = rows.map((row) => ({
      id: row.id,
      item_type: row.item_type,
      added_at: row.added_at,
      item: detailsByType[row.item_type]?.[row.item_id] ?? null,
    }));

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// GET /library/:itemType/:itemId — l'utilisateur a-t-il déjà sauvegardé cet élément ?
libraryRouter.get("/:itemType/:itemId", requireAuth, async (req, res, next) => {
  try {
    const { itemType, itemId } = req.params;
    const { data, error } = await supabaseAdmin
      .from("library")
      .select("id")
      .eq("user_id", req.auth!.id)
      .eq("item_type", itemType)
      .eq("item_id", itemId)
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
    const { itemType, itemId } = req.params;
    if (!ITEM_TYPES.includes(itemType as ItemType)) {
      return res.status(400).json({ error: `item_type must be one of: ${ITEM_TYPES.join(", ")}` });
    }

    const { error } = await supabaseAdmin
      .from("library")
      .insert({ user_id: req.auth!.id, item_type: itemType, item_id: itemId });

    if (error && error.code !== "23505") throw error;
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// DELETE /library/:itemType/:itemId
libraryRouter.delete("/:itemType/:itemId", requireAuth, async (req, res, next) => {
  try {
    const { itemType, itemId } = req.params;
    const { error } = await supabaseAdmin
      .from("library")
      .delete()
      .eq("user_id", req.auth!.id)
      .eq("item_type", itemType)
      .eq("item_id", itemId);

    if (error) throw error;
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
