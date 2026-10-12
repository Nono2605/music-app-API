import type { NextFunction, Request, Response } from "express";

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
}

// Ce que le client voit d'une erreur NON prévue. Les erreurs Postgrest/Supabase (`if (error) throw
// error`, utilisé dans tous les modules) sont de simples objets { code, message, details, hint } :
// leur message cite des noms de tables, de colonnes ou de contraintes, qu'un visiteur n'a pas à
// connaître. Le détail reste dans les journaux du serveur (Render) ; le client reçoit un message
// générique. Les erreurs de lecture de la requête (JSON invalide, corps trop gros) viennent d'Express
// avec un statut 4xx : elles gardent leur statut, avec un texte neutre.
const CLIENT_ERRORS: Record<number, string> = {
  400: "Invalid request",
  413: "Request body too large",
  415: "Unsupported content type",
};

export interface ErrorResponse {
  status: number;
  body: { error: string; code?: string };
}

export function errorResponse(err: unknown): ErrorResponse {
  if (typeof err === "object" && err !== null) {
    const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
    const code = typeof status === "number" ? status : statusCode;
    if (typeof code === "number" && code >= 400 && code < 500) {
      return { status: code, body: { error: CLIENT_ERRORS[code] ?? "Request error" } };
    }
  }
  return { status: 500, body: { error: "Internal server error", code: "internal_error" } };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const response = errorResponse(err);
  if (response.status >= 500) console.error(err);
  res.status(response.status).json(response.body);
}
