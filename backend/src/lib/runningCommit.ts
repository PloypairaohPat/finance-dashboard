// Which commit this process is running, for the startup log and GET /health.
//
// Railway injects RAILWAY_GIT_COMMIT_SHA at runtime when a deploy was
// triggered from GitHub; a CLI deploy (`railway up`) or a local run has none.
// The repo is public, so the commit isn't a secret. Anything that isn't a
// hex sha reads as "unknown" rather than being echoed.

export function runningCommit(sha: string | undefined = process.env.RAILWAY_GIT_COMMIT_SHA): string {
  return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7).toLowerCase() : 'unknown'
}
