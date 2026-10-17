// Paramètres de GET /library et de GET /library/ids, et règles de visibilité des éléments
// sauvegardés. Fonctions pures (testées sans base).

import { isUuid, parseListParams, type ListParams } from "../albums/list";

export const ITEM_TYPES = ["track", "album", "artist", "playlist"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export function isItemType(value: unknown): value is ItemType {
  return typeof value === "string" && (ITEM_TYPES as readonly string[]).includes(value);
}

/** Au plus autant d'identifiants par réponse de /library/ids (quelques centaines de Ko). */
export const MAX_IDS = 5000;

export type LibraryParams = ListParams & { type: ItemType | null };

/** Par défaut une page de /library porte 100 éléments (le maximum) : une version de la webapp qui n'envoie pas encore `limit` voit presque tout. */
export const DEFAULT_LIBRARY_LIMIT = 100;

/** `type` absent : tous les types ; présent mais inconnu : null (la route répond 400). */
export function parseLibraryParams(query: Record<string, unknown>): LibraryParams | null {
  const parsed = parseListParams(query);
  const base = query.limit === undefined ? { ...parsed, limit: DEFAULT_LIBRARY_LIMIT } : parsed;
  if (query.type === undefined) return { ...base, type: null };
  return isItemType(query.type) ? { ...base, type: query.type } : null;
}

/** Un élément de la route /library/:itemType/:itemId : le type est connu et l'identifiant est un UUID. */
export function parseItem(itemType: unknown, itemId: unknown): { type: ItemType; id: string } | null {
  return isItemType(itemType) && isUuid(itemId) ? { type: itemType, id: itemId } : null;
}

/**
 * Une playlist sauvegardée reste visible si elle est publique, ou si elle est à l'utilisateur.
 * Si son auteur la repasse en privée, elle disparaît des favoris des autres.
 */
export function playlistVisibleTo(
  userId: string,
  playlist: { owner_id?: string | null; is_public?: boolean | null }
): boolean {
  return playlist.is_public === true || playlist.owner_id === userId;
}
