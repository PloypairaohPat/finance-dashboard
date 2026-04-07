import { PrismaClient }      from '@prisma/client'
import dotenv                from 'dotenv'
import { cleanTransactions } from '../services/cleaner'

dotenv.config()

const prisma  = new PrismaClient()
const USER_ID = process.env.DEFAULT_USER_ID!

async function main() {
  console.log('🧹 Running backfill clean...\n')
  const result = await cleanTransactions(prisma, USER_ID)
  console.log(`✓ normalized ${result.normalized} merchant names`)
  console.log(`✓ resolved   ${result.resolved} pending duplicates`)
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })