// The summary script's lookup: which account or Item to look up, read at a
// prompt and never from the command line, so the id stays out of shell
// history and process listings. The id is hashed locally and never printed.

import { createInterface } from 'node:readline'

export interface LookupTarget {
  kind: 'user' | 'item'
  id: string
}

/** The flags the summary script takes; anything else on the command line is refused. */
export const SUMMARY_FLAGS_WITH_VALUE = new Set(['--allow-remote', '--url-env'])
export const SUMMARY_FLAGS = new Set(['--lookup'])

/** True when argv holds only the script's own flags (and their values). Never echoes what it found. */
export function onlyKnownArgs(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const name = a.split('=')[0]
    if (SUMMARY_FLAGS.has(a)) continue
    if (SUMMARY_FLAGS_WITH_VALUE.has(name)) {
      if (!a.includes('=')) i++
      continue
    }
    return false
  }
  return true
}

/** Ask what to look up. Null when nothing usable was typed. */
export async function askLookup(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<LookupTarget | null> {
  const rl = createInterface({ input, terminal: false })
  // The iterator buffers lines, so input that arrives before a prompt isn't lost.
  const lines = rl[Symbol.asyncIterator]()
  const ask = async (prompt: string): Promise<string> => {
    output.write(prompt)
    const next = await lines.next()
    return next.done ? '' : String(next.value).trim()
  }
  try {
    const kind = (await ask('Look up an account (a) or a bank connection by Plaid item_id (i)? ')).toLowerCase()
    if (kind !== 'a' && kind !== 'i') return null
    const id = await ask(kind === 'a' ? 'Clerk user id: ' : 'Plaid item_id: ')
    output.write('\n')
    return id ? { kind: kind === 'a' ? 'user' : 'item', id } : null
  } finally {
    rl.close()
  }
}
