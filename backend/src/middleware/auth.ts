import { clerkMiddleware, requireAuth, getAuth } from "@clerk/express";
import { Request, Response, NextFunction } from "express";

// The demo user seeded by prisma/seed-demo.ts. Demo requests always resolve
// to this id and nothing else. Keep this value in sync with seed-demo.ts.
export const DEMO_USER_ID = "demo-user";

// Clerk middleware — parses the session token from the Authorization header.
// Apply globally with app.use(clerkAuth).
export const clerkAuth = clerkMiddleware();

// A request opts into demo mode with the header `X-Demo-Mode: 1`.
// Demo mode grants READ-ONLY access to the public demo user's sample data.
// It can never resolve to a real user, so it exposes nothing private.
function isDemoRequest(req: Request): boolean {
  return req.header("X-Demo-Mode") === "1";
}

const clerkRequireSession = requireAuth();

// Require authentication — but let demo requests through without a Clerk
// session. Same middleware signature as before, so every existing
// `router.get("/", requireSession, ...)` keeps working unchanged.
export function requireSession(req: Request, res: Response, next: NextFunction) {
  if (isDemoRequest(req)) return next();
  return clerkRequireSession(req, res, next);
}

// Read-only guard for demo mode. Blocks every mutating request so a visitor
// can't alter the demo data or reach Plaid (create/exchange link tokens).
// Apply globally in server.ts with app.use(demoReadOnly), right after
// app.use(clerkAuth).
export function demoReadOnly(req: Request, res: Response, next: NextFunction) {
  const isWrite = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (isDemoRequest(req) && isWrite) {
    return res.status(200).json({
      demo: true,
      ok: false,
      message: "Demo mode — changes aren't saved. Sign up to use it for real.",
    });
  }
  return next();
}

// Extract the userId from a verified request. Demo requests always map to the
// demo user; everyone else gets their verified Clerk userId.
export function getUserId(req: Request): string {
  if (isDemoRequest(req)) return DEMO_USER_ID;
  const auth = getAuth(req);
  if (!auth?.userId) {
    throw new Error("Unauthorized: no userId in session");
  }
  return auth.userId;
}
