#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────
//  audit-gate — the dependency-audit check (M7.7).
//
//    node .github/scripts/audit-gate.mjs --mode enforce|report [--allowlist FILE] <app dir>...
//
//  For each app directory, two `npm audit --json` runs, from the lockfile
//  (no install needed):
//    - runtime (--omit=dev): what the backend runs and the frontend ships.
//      A high or critical advisory here fails the gate, unless the allowlist
//      accepts it.
//    - everything: the rest (build tooling, test tooling) is summarised and
//      never fails.
//
//  --mode report prints what would fail and always exits 0. The workflow
//  picks enforce only when it can fairly blame the change: a PR that touches
//  a package.json, a lockfile, the allowlist or the gate itself, the weekly
//  run on main, and manual runs. Every other PR gets report, so one new
//  advisory in an unrelated transitive package can't block every merge.
//
//  The allowlist (.github/audit-allowlist.json) accepts a risk per advisory
//  and package, with a reason and a review date. Keyed by advisory, so a new
//  advisory in the same package still fails. An entry past its reviewBy date
//  fails the gate until it's renewed or removed; an entry that matches
//  nothing is flagged so it can be deleted.
// ─────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BLOCKING = ['high', 'critical']
const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info']
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** One row per (advisory, package) in an `npm audit --json` report. */
export function advisoriesOf(report) {
  const seen = new Map()
  for (const v of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via !== 'object' || via === null) continue
      const id = /GHSA(-[a-z0-9]{4}){3}/i.exec(via.url ?? '')?.[0] ?? `npm-advisory-${via.source}`
      const pkg = via.name ?? v.name
      const key = `${id}|${pkg}`
      if (!seen.has(key)) seen.set(key, { id, package: pkg, severity: via.severity, title: via.title ?? '', url: via.url ?? '' })
    }
  }
  return [...seen.values()]
}

/** The allowlist's entries, and every problem with them. */
export function validateAllowlist(doc) {
  const errors = []
  const entries = []
  if (!doc || !Array.isArray(doc.entries)) return { entries, errors: ['the allowlist needs an "entries" array'] }
  doc.entries.forEach((e, i) => {
    const where = `allowlist entry ${i + 1}`
    const bad = []
    if (typeof e?.advisory !== 'string' || !GHSA.test(e.advisory)) bad.push('"advisory" must be a GHSA id')
    if (typeof e?.package !== 'string' || !e.package.trim()) bad.push('"package" is required')
    if (typeof e?.reason !== 'string' || e.reason.trim().length < 20) bad.push('"reason" must say why (20 characters or more)')
    if (typeof e?.reviewBy !== 'string' || !DATE.test(e.reviewBy) || Number.isNaN(Date.parse(`${e.reviewBy}T00:00:00Z`))) bad.push('"reviewBy" must be a date, YYYY-MM-DD')
    if (bad.length) errors.push(`${where}: ${bad.join('; ')}`)
    else entries.push(e)
  })
  return { entries, errors }
}

/**
 * The verdict for one run.
 *   runtime: { app: report } from `npm audit --omit=dev`
 *   full:    { app: report } from `npm audit`
 *   failed:  apps whose audit produced no report, with why
 *   today:   YYYY-MM-DD (UTC); an entry is good through its reviewBy day
 */
export function evaluate({ runtime, full, allowlist, today, failed = {} }) {
  const { entries, errors } = validateAllowlist(allowlist)
  const blocking = [], allowed = [], expired = [], below = []
  const used = new Set()
  const tooling = {}
  for (const [app, report] of Object.entries(runtime)) {
    const rows = advisoriesOf(report)
    for (const a of rows) {
      if (!BLOCKING.includes(a.severity)) { below.push({ app, ...a }); continue }
      const entry = entries.find((e) => e.advisory.toUpperCase() === a.id.toUpperCase() && e.package === a.package)
      if (!entry) { blocking.push({ app, ...a }); continue }
      used.add(entry)
      if (today > entry.reviewBy) expired.push({ app, ...a, entry })
      else allowed.push({ app, ...a, entry })
    }
    const runtimeKeys = new Set(rows.map((a) => `${a.id}|${a.package}`))
    const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]))
    for (const a of advisoriesOf(full[app])) if (!runtimeKeys.has(`${a.id}|${a.package}`)) counts[a.severity] = (counts[a.severity] ?? 0) + 1
    tooling[app] = counts
  }
  const unused = entries.filter((e) => !used.has(e))
  const auditErrors = Object.entries(failed).map(([app, why]) => `${app}: npm audit produced no report (${why})`)
  return { blocking, allowed, expired, below, unused, errors: [...errors, ...auditErrors], tooling }
}

/** Whether this verdict fails the check in this mode. */
export function fails(verdict, mode) {
  if (mode !== 'enforce') return false
  return verdict.blocking.length > 0 || verdict.expired.length > 0 || verdict.errors.length > 0
}

function audit(dir, omitDev) {
  const args = ['audit', '--json', ...(omitDev ? ['--omit=dev'] : [])]
  // npm exits non-zero when it finds anything; only the JSON matters.
  // Windows runs npm through a shell; the arguments are fixed, so one command string.
  const opts = { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  const r = process.platform === 'win32' ? spawnSync(['npm', ...args].join(' '), { ...opts, shell: true }) : spawnSync('npm', args, opts)
  try {
    const report = JSON.parse(r.stdout)
    if (report.error) return { error: report.error.summary ?? report.error.code ?? 'npm reported an error' }
    return { report }
  } catch {
    return { error: (r.stderr || 'no output').trim().split('\n').pop().slice(0, 200) }
  }
}

function render(verdict, mode, willFail) {
  const lines = []
  const row = (a) => `| ${a.app} | ${a.severity} | ${a.package} | [${a.id}](${a.url}) | ${a.title.replace(/\|/g, '\\|')} |`
  lines.push(`## Dependency audit (${mode})`, '')
  lines.push(willFail ? '**Fails:** see below.' : mode === 'enforce' ? '**Passes.**' : '**Report only:** this PR changes no dependency files, so nothing here fails it.', '')
  if (verdict.errors.length) lines.push('### Problems', '', ...verdict.errors.map((e) => `- ${e}`), '')
  if (verdict.blocking.length) lines.push('### Runtime, high or critical', '', '| app | severity | package | advisory | title |', '|---|---|---|---|---|', ...verdict.blocking.map(row), '')
  if (verdict.expired.length) lines.push('### Accepted, but past its review date', '', ...verdict.expired.map((a) => `- ${a.app}: ${a.package} ${a.id}, reviewBy ${a.entry.reviewBy}. Renew it with a fresh reason, or remove it.`), '')
  if (verdict.allowed.length) lines.push('### Runtime, accepted in the allowlist', '', ...verdict.allowed.map((a) => `- ${a.app}: ${a.package} ${a.id} (${a.severity}), until ${a.entry.reviewBy}: ${a.entry.reason}`), '')
  if (verdict.unused.length) lines.push('### Allowlist entries that match nothing (delete them)', '', ...verdict.unused.map((e) => `- ${e.package} ${e.advisory}`), '')
  if (verdict.below.length) lines.push('### Runtime, moderate or lower (never fails)', '', '| app | severity | package | advisory | title |', '|---|---|---|---|---|', ...verdict.below.map(row), '')
  lines.push('### Build and test tooling (never fails)', '', '| app | critical | high | moderate | low |', '|---|---|---|---|---|')
  for (const [app, c] of Object.entries(verdict.tooling)) lines.push(`| ${app} | ${c.critical} | ${c.high} | ${c.moderate} | ${c.low} |`)
  return lines.join('\n') + '\n'
}

function main(argv) {
  const args = [...argv]
  const take = (flag) => { const i = args.indexOf(flag); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v }
  const mode = take('--mode') ?? 'enforce'
  if (!['enforce', 'report'].includes(mode)) { console.error(`--mode must be enforce or report, not ${mode}`); return 2 }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const allowlistPath = take('--allowlist') ?? path.join(root, '.github', 'audit-allowlist.json')
  const dirs = args.length ? args : ['backend', 'frontend']

  let allowlist
  try { allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')) } catch (e) { allowlist = { entries: null, readError: e.message } }

  const runtime = {}, full = {}, failed = {}
  for (const dir of dirs) {
    const app = path.basename(path.resolve(dir))
    const r = audit(dir, true), f = audit(dir, false)
    if (r.error || f.error) { failed[app] = r.error ?? f.error; continue }
    runtime[app] = r.report
    full[app] = f.report
  }
  const today = new Date().toISOString().slice(0, 10)
  const verdict = evaluate({ runtime, full, allowlist, today, failed })
  if (allowlist.readError) verdict.errors.unshift(`the allowlist could not be read: ${allowlist.readError}`)
  const willFail = fails(verdict, mode)
  const summary = render(verdict, mode, willFail)

  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  if (process.env.GITHUB_ACTIONS) {
    const level = mode === 'enforce' ? 'error' : 'warning'
    for (const a of verdict.blocking) console.log(`::${level} title=${a.severity} runtime advisory (${a.app})::${a.package} ${a.id}: ${a.title}`)
    for (const a of verdict.expired) console.log(`::${level} title=Allowlist entry past review::${a.package} ${a.id} (reviewBy ${a.entry.reviewBy})`)
    for (const e of verdict.errors) console.log(`::${level} title=Dependency audit::${e}`)
    for (const e of verdict.unused) console.log(`::warning title=Unused allowlist entry::${e.package} ${e.advisory}`)
  }
  return willFail ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
