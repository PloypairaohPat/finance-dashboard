import { Request, Response } from 'express'
import { fetchAccounts }     from '../services/accounts.service'

export async function getAccounts(_req: Request, res: Response): Promise<void> {
  try {
    const accounts = await fetchAccounts()
    res.json({ accounts })
  } catch (err: any) {
    console.error('❌ getAccounts:', err.message)
    res.status(500).json({ error: 'Failed to fetch accounts' })
  }
}