import { clerkMiddleware, requireAuth, getAuth } from "@clerk/express";
import { Request } from "express";

// Clerk middleware — parses the session token from the Authorization header.
// Apply this globally with app.use(clerkAuth).
export const clerkAuth = clerkMiddleware();

// Require authentication — returns 401 if no valid session.
// Apply to protected routes.
export const requireSession = requireAuth();

// Helper to extract userId from a verified request.
export function getUserId(req: Request): string {
  const auth = getAuth(req);
  if (!auth?.userId) {
    throw new Error("Unauthorized: no userId in session");
  }
  return auth.userId;
}
