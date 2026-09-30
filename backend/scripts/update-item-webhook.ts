// ─────────────────────────────────────────────────────────────────
//  update-item-webhook — point ONE Plaid Item's webhook at this backend.
//
//  Plaid stores the webhook URL on the Item when it is created, and nothing
//  re-sends it: changing WEBHOOK_URL in Railway fixes new Items only. Four
//  Items were created while WEBHOOK_URL still named a dead Railway domain
//  (see src/lib/webhookUrl.ts for the incident). This calls Plaid's
//  /item/webhook/update for one of them.
//
//  What it changes: the webhook URL Plaid holds for that Item. Nothing else.
//  Our database is opened READ-ONLY (scripts/lib/read-only-db.ts) and only
//  used to find the Item's access token; no row is written.
//
//  Safety, in the order it runs:
//    - --item <Plaid item_id> is required: one Item per run, by the id the
//      audit prints.
//    - --expect-host <host> is required and must equal WEBHOOK_URL's host.
//      The bug being fixed WAS a stale WEBHOOK_URL; without this, a run could
//      faithfully "fix" Items to another dead domain. You state where the
//      webhook should go; the script refuses unless the environment agrees.
//    - PLAID_ENV must be production, and PLAID_SECRET / ENCRYPTION_KEY must be
//      set — they exist only in Railway, so this runs under `railway run`.
//    - /item/get first. An Item already pointing at the target is left alone.
//    - --dry-run does everything above and stops before the update.
//    - After a real update, /item/get again: the Item must now report the new
//      host, or the run exits non-zero.
//
//  The access token is decrypted into a local and passed to Plaid; it is never
//  printed, logged or returned. Everything printed goes through redact().
//
//    railway run npx tsx scripts/update-item-webhook.ts --item <item_id> \
//      --expect-host <backend host> --allow-remote <db host> --dry-run
// ─────────────────────────────────────────────────────────────────

import { connectReadOnly, flag, hasFlag, makeRefuse, redact } from './lib/read-only-db'
import { checkWebhookUrl } from '../src/lib/webhookUrl'

const SCRIPT = 'update-item-webhook'
// Typed explicitly: TypeScript only narrows after a never-returning call when
// the callee's type is declared, not inferred.
const refuse: (message: string) => never = makeRefuse(SCRIPT)
const DEMO_USER_IDS = new Set(['demo-user'])

const hostOf = (url: string | null | undefined): string => {
  if (!url) return '(none set)'
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return '(unparseable)'
  }
}
/** The Item id is not a secret, but there is no reason to print all of it. */
const short = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id)

function describePlaidError(e: any): string {
  const data = e?.response?.data ?? {}
  const parts = [
    e?.response?.status ? `HTTP ${e.response.status}` : null,
    data.error_type ? `type ${data.error_type}` : null,
    data.error_code ? `code ${data.error_code}` : null,
    data.request_id ? `request_id ${data.request_id}` : null,
  ].filter(Boolean)
  return redact(parts.length ? parts.join(', ') : String(e?.message ?? e))
}

async function main() {
  const dryRun = hasFlag('dry-run')

  // ── What the operator asked for, checked before anything connects ──
  const itemId = flag('item')
  if (!itemId || itemId.startsWith('--')) refuse('--item <Plaid item_id> is required. The audit prints them.')

  const expectHost = flag('expect-host')?.toLowerCase()
  if (!expectHost || expectHost.startsWith('--')) {
    refuse('--expect-host <host> is required: the backend host the webhook should point at, e.g. the one serving /health.')
  }

  const target = process.env.WEBHOOK_URL
  const targetCheck = checkWebhookUrl(target, process.env.RAILWAY_PUBLIC_DOMAIN)
  if (targetCheck.level === 'error') refuse(targetCheck.message)
  if (hostOf(target) !== expectHost) {
    refuse(
      `WEBHOOK_URL points at ${hostOf(target)}, but --expect-host says ${expectHost}.\n` +
      '  Updating an Item would send its webhooks to WEBHOOK_URL, so the two must agree.\n' +
      '  If WEBHOOK_URL is wrong, fix it in the Railway dashboard first: that is the bug this repairs.',
    )
  }
  if (!new URL(target!).protocol.startsWith('https')) refuse(`WEBHOOK_URL must be https for Plaid to deliver: ${target}`)

  if (process.env.PLAID_ENV !== 'production') {
    refuse(`PLAID_ENV is "${process.env.PLAID_ENV ?? '(unset)'}", not production. This repairs production Items; run it under \`railway run\`.`)
  }
  for (const key of ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'ENCRYPTION_KEY']) {
    if (!process.env[key]) refuse(`${key} is not set. It exists only in Railway: run this under \`railway run\`.`)
  }

  // ── Find the Item, read-only ────────────────────────────────────
  const db = await connectReadOnly(SCRIPT)
  const item = await db.prisma.plaidItem.findUnique({
    where: { itemId: itemId! },
    select: { itemId: true, userId: true, institutionName: true, accessToken: true, createdAt: true },
  })
  await db.prisma.$disconnect()
  if (!item) refuse(`no Plaid item with item_id ${short(itemId!)} in ${db.database} on ${db.host}.`)
  if (DEMO_USER_IDS.has(item.userId)) refuse('that Item belongs to the demo user, which has no real Plaid Item.')

  console.log(`\n${SCRIPT}${dryRun ? '  — DRY RUN, nothing will be changed' : ''}`)
  console.log(`  item        ${short(item.itemId)}  (${item.institutionName ?? 'unknown institution'}, created ${item.createdAt.toISOString().slice(0, 10)})`)
  console.log(`  user        ${item.userId.slice(0, 12)}…`)
  console.log(`  database    ${db.database} on ${db.host} via ${db.envName}, read-only`)
  console.log(`  target      ${target}`)
  console.log(`  check       ${targetCheck.message}`)

  const { plaidClient } = await import('../src/lib/plaidClient')
  const { decrypt } = await import('../src/utils/encrypt')
  const accessToken = decrypt(item.accessToken)

  // ── What Plaid holds now ────────────────────────────────────────
  let current: string | null
  try {
    const res = await plaidClient.itemGet({ access_token: accessToken })
    current = res.data.item.webhook ?? null
  } catch (e) {
    refuse(`/item/get failed: ${describePlaidError(e)}`)
  }
  console.log(`  currently   ${current ?? '(no webhook set)'}`)

  if (hostOf(current) === expectHost && current === target) {
    console.log('\n  Already pointing at the target. Nothing to do.\n')
    return
  }

  if (dryRun) {
    console.log(`\n  Would call /item/webhook/update: ${hostOf(current)} → ${hostOf(target)}.`)
    console.log('  Dry run: Plaid was only read. Re-run without --dry-run to apply.\n')
    return
  }

  // ── The one change ──────────────────────────────────────────────
  try {
    const res = await plaidClient.itemWebhookUpdate({ access_token: accessToken, webhook: target! })
    console.log(`\n  /item/webhook/update  HTTP ${res.status}, request_id ${res.data.request_id}`)
    console.log(`  Plaid now reports    ${res.data.item.webhook ?? '(no webhook set)'}`)
  } catch (e) {
    refuse(`/item/webhook/update failed, the Item is unchanged: ${describePlaidError(e)}`)
  }

  // ── Read it back rather than trusting the response ──────────────
  const after = (await plaidClient.itemGet({ access_token: accessToken })).data.item.webhook ?? null
  if (after !== target) {
    refuse(`read back ${after ?? '(no webhook set)'} after the update, not ${target}.`)
  }
  console.log(`  Read back via /item/get: ${after}  ✓`)
  console.log('\n  Done. Plaid sends this Item a WEBHOOK_UPDATE_ACKNOWLEDGED webhook at the new URL;')
  console.log('  it should appear in Railway\'s logs as evt "plaid.webhook" within a minute or two.\n')
}

main().catch((e) => {
  // Redacted: a Plaid SDK error can quote the request, which carries the token.
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})
