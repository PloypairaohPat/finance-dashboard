// Tests for audit-gate.mjs:  node --test .github/scripts/audit-gate.test.mjs
// The advisories below are invented; only their shape matches npm's.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { advisoriesOf, evaluate, fails, validateAllowlist } from './audit-gate.mjs'

const A = 'GHSA-2222-3333-4444'
const B = 'GHSA-5555-6666-7777'
const C = 'GHSA-8888-9999-cccc'

/** An `npm audit --json` report: each [package, severity, advisory id], plus a parent that only points at it. */
function report(rows) {
  const vulnerabilities = {}
  for (const [pkg, severity, id] of rows) {
    const v = (vulnerabilities[pkg] ??= { name: pkg, severity, via: [] })
    v.via.push({ source: 1, name: pkg, title: `invented ${id}`, url: `https://github.com/advisories/${id}`, severity, range: '<1.0.0' })
    vulnerabilities[`parent-of-${pkg}`] = { name: `parent-of-${pkg}`, severity, via: [pkg] }
  }
  return { vulnerabilities }
}
const entry = (over = {}) => ({ advisory: A, package: 'alpha', reason: 'not reachable: we never call the affected function', reviewBy: '2026-12-31', ...over })
const run = (runtimeRows, { full = runtimeRows, entries = [], today = '2026-10-07' } = {}) =>
  evaluate({ runtime: { app: report(runtimeRows) }, full: { app: report(full) }, allowlist: { entries }, today })

test('reads one row per advisory and package, ignoring parents that only point at it', () => {
  const rows = advisoriesOf(report([['alpha', 'high', A], ['alpha', 'moderate', B]]))
  assert.deepEqual(rows.map((r) => [r.id, r.package, r.severity]), [[A, 'alpha', 'high'], [B, 'alpha', 'moderate']])
})

test('a high or critical runtime advisory fails in enforce mode', () => {
  for (const severity of ['high', 'critical']) {
    const v = run([['alpha', severity, A]])
    assert.equal(v.blocking.length, 1)
    assert.equal(fails(v, 'enforce'), true)
  }
})

test('report mode never fails, whatever it finds', () => {
  const v = evaluate({ runtime: { app: report([['alpha', 'critical', A]]) }, full: { app: report([]) }, allowlist: { entries: [entry({ reviewBy: '2020-01-01' })] }, today: '2026-10-07', failed: { other: 'offline' } })
  assert.equal(fails(v, 'report'), false)
  assert.equal(fails(v, 'enforce'), true)
})

test('moderate and lower runtime advisories are listed but never fail', () => {
  const v = run([['alpha', 'moderate', A], ['beta', 'low', B]])
  assert.equal(v.blocking.length, 0)
  assert.equal(v.below.length, 2)
  assert.equal(fails(v, 'enforce'), false)
})

test('build tooling is counted, never fails, and runtime advisories are not counted twice', () => {
  const v = run([['alpha', 'moderate', A]], { full: [['alpha', 'moderate', A], ['webpack-ish', 'critical', B], ['jest-ish', 'high', C]] })
  assert.deepEqual(v.tooling.app, { critical: 1, high: 1, moderate: 0, low: 0, info: 0 })
  assert.equal(fails(v, 'enforce'), false)
})

test('an allowlist entry accepts its advisory through its reviewBy day', () => {
  for (const today of ['2026-10-07', '2026-12-31']) {
    const v = run([['alpha', 'high', A]], { entries: [entry()], today })
    assert.equal(v.allowed.length, 1, today)
    assert.equal(fails(v, 'enforce'), false, today)
  }
})

test('an entry past its reviewBy date fails until renewed or removed', () => {
  const v = run([['alpha', 'high', A]], { entries: [entry()], today: '2027-01-01' })
  assert.equal(v.expired.length, 1)
  assert.equal(fails(v, 'enforce'), true)
})

test('an entry is keyed by advisory: a new advisory in the same package still fails', () => {
  const v = run([['alpha', 'high', A], ['alpha', 'high', B]], { entries: [entry()] })
  assert.deepEqual(v.blocking.map((a) => a.id), [B])
  assert.equal(fails(v, 'enforce'), true)
})

test('an entry for the same advisory in another package does not cover it', () => {
  const v = run([['alpha', 'high', A]], { entries: [entry({ package: 'beta' })] })
  assert.equal(v.blocking.length, 1)
})

test('an entry that matches nothing is flagged, without failing', () => {
  const v = run([], { entries: [entry()] })
  assert.deepEqual(v.unused.map((e) => e.advisory), [A])
  assert.equal(fails(v, 'enforce'), false)
})

test('a malformed entry fails: advisory, package, reason and reviewBy are all required', () => {
  const bad = [
    entry({ advisory: 'CVE-2026-0001' }), entry({ package: '' }), entry({ reason: 'n/a' }),
    entry({ reviewBy: 'next year' }), entry({ reviewBy: '2026-13-45' }),
  ]
  for (const e of bad) {
    const v = run([], { entries: [e] })
    assert.equal(v.errors.length, 1, JSON.stringify(e))
    assert.equal(fails(v, 'enforce'), true)
  }
  assert.match(validateAllowlist({}).errors[0], /entries/)
})

test('an audit that produced no report fails in enforce mode', () => {
  const v = evaluate({ runtime: {}, full: {}, allowlist: { entries: [] }, today: '2026-10-07', failed: { backend: 'registry unreachable' } })
  assert.equal(fails(v, 'enforce'), true)
  assert.match(v.errors[0], /backend: npm audit produced no report/)
})

test('the committed allowlist is valid, and empty', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'audit-allowlist.json')
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(validateAllowlist(doc).errors, [])
  assert.deepEqual(doc.entries, [])
})
