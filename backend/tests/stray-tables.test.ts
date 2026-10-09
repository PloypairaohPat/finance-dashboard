// ─────────────────────────────────────────────────────────────────
//  Stray tables (M7.7): every table in public is a user table or a known
//  non-user one, a hand-made copy is caught by name, and the migration that
//  drops "Budget_backup_m53" works where it exists and is harmless where it
//  doesn't. Copies here are made WITH NO DATA: no rows are ever copied.
// ─────────────────────────────────────────────────────────────────

import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import prisma from '../src/lib/prisma'
import { NON_DEMO_TABLES } from '../src/lib/userFingerprint'
import { KNOWN_NON_USER_TABLES, strayTables } from '../scripts/lib/stray-tables'

const BACKEND = path.resolve(__dirname, '..')
const tableExists = async (name: string) =>
  (await prisma.$queryRawUnsafe<Array<{ t: string | null }>>(`SELECT to_regclass($1)::text AS t`, `public."${name}"`))[0].t !== null

describe('stray tables', () => {
  it('none in a database built from the migrations', async () => {
    expect(await strayTables(prisma)).toEqual([])
  })

  it('the known non-user tables exist, and none is also a user table', async () => {
    for (const t of KNOWN_NON_USER_TABLES) expect(await tableExists(t), t).toBe(true)
    const user = new Set(NON_DEMO_TABLES.map(([t]) => t))
    expect(KNOWN_NON_USER_TABLES.filter((t) => user.has(t))).toEqual([])
  })

  it('catches a copy made by hand, by name', async () => {
    const name = `Budget_copy_${randomBytes(3).toString('hex')}`
    await prisma.$executeRawUnsafe(`CREATE TABLE "${name}" AS SELECT * FROM "Budget" WITH NO DATA`)
    try {
      expect(await strayTables(prisma)).toEqual([name])
    } finally {
      await prisma.$executeRawUnsafe(`DROP TABLE "${name}"`)
    }
  })

  it('the inventory script reports them and exits 2', () => {
    const src = readFileSync(path.join(BACKEND, 'scripts', 'user-data-inventory.ts'), 'utf8')
    expect(src).toMatch(/const stray = await strayTables\(db\.prisma\)/)
    expect(src).toMatch(/if \(stray\.length\) \{[\s\S]{0,200}process\.exitCode = 2/)
  })
})

describe('the drop_budget_backup_m53 migration', () => {
  const dir = readdirSync(path.join(BACKEND, 'prisma', 'migrations')).find((d) => d.endsWith('_drop_budget_backup_m53'))
  const sql = () => readFileSync(path.join(BACKEND, 'prisma', 'migrations', dir!, 'migration.sql'), 'utf8')

  it('drops the table where it exists, and does nothing where it does not', async () => {
    expect(dir).toBeDefined()
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Budget_backup_m53" AS SELECT * FROM "Budget" WITH NO DATA`)
    try {
      expect(await strayTables(prisma)).toEqual(['Budget_backup_m53'])
      await prisma.$executeRawUnsafe(sql())
      expect(await tableExists('Budget_backup_m53')).toBe(false)
      await expect(prisma.$executeRawUnsafe(sql())).resolves.toBeDefined()
      expect(await strayTables(prisma)).toEqual([])
    } finally {
      // Never leave it behind for the next test, even when this one fails.
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "Budget_backup_m53"`)
    }
  })

  it('touches nothing else: one DROP TABLE IF EXISTS, of that table', () => {
    const statements = sql().split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--'))
    expect(statements).toEqual(['DROP TABLE IF EXISTS "Budget_backup_m53";'])
  })
})
