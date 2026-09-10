import type { NextFunction, Request, Response } from "express";

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
}

// Les erreurs Postgrest/Supabase (`if (error) throw error`, utilisé dans
// tous les modules) ne sont PAS des instances d'Error — juste des objets
// { code, message, details, hint }. Sans ce cas, `err instanceof Error`
// est faux et tout finissait en "Internal server error" générique, même
// quand le message réel ("column X does not exist", violation de
// contrainte, etc.) aurait été bien plus utile pour diagnostiquer.
function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return "Internal server error";
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  console.error(err);
  res.status(500).json({ error: extractMessage(err) });
}
