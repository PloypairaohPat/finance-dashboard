import prisma from "../lib/prisma"
import {
  mapPlaidCategory,
  DISPLAY_CATEGORIES,
  type DisplayCategory,
} from "../lib/categoryMap"

const DRY = process.argv.includes("--dry-run")

async function main() {
  const all = await prisma.budget.findMany()

  console.log(`Loaded ${all.length} budgets.`)

  const isDisplay = (c: string): c is DisplayCategory =>
    (DISPLAY_CATEGORIES as readonly string[]).includes(c)

  type Group = {
    ids: string[]
    total: number
    mapped: DisplayCategory
    userId: string
  }

  const groups = new Map<string, Group>()

  for (const b of all) {
    const mapped = isDisplay(b.category)
      ? (b.category as DisplayCategory)
      : mapPlaidCategory(b.category)

    const key = `${b.userId}|${mapped}`

    const g = groups.get(key) ?? {
      ids: [],
      total: 0,
      mapped,
      userId: b.userId,
    }

    g.ids.push(b.id)
    g.total += Number(b.monthlyLimit)

    groups.set(key, g)
  }

  let updated = 0
  let merged = 0
  let deleted = 0

  for (const g of groups.values()) {
    if (g.ids.length === 1) {
      const original = all.find((b) => b.id === g.ids[0])!

      if (original.category === g.mapped) continue

      console.log(`UPDATE ${original.category} -> ${g.mapped}`)

      if (!DRY) {
        await prisma.budget.update({
          where: { id: g.ids[0] },
          data: { category: g.mapped },
        })
      }

      updated++
    } else {
      const [keep, ...rest] = g.ids

      console.log(
        `MERGE ${g.ids.length} rows -> ${g.mapped} total=${g.total}`
      )

      if (!DRY) {
        await prisma.$transaction([
          prisma.budget.update({
            where: { id: keep },
            data: {
              category: g.mapped,
              monthlyLimit: g.total,
            },
          }),

          ...rest.map((id) =>
            prisma.budget.delete({
              where: { id },
            })
          ),
        ])
      }

      merged++
      deleted += rest.length
    }
  }

  console.log("")
  console.log(`${DRY ? "[DRY RUN]" : "DONE"}`)
  console.log(`Renamed: ${updated}`)
  console.log(`Merged: ${merged}`)
  console.log(`Deleted: ${deleted}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })