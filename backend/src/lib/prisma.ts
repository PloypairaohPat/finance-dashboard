// Before (CommonJS):
// const { PrismaClient } = require('@prisma/client')

// After (TypeScript):
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

export default prisma