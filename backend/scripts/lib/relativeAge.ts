// How long ago, never a date: inventory output stays free of timestamps that
// could pin down a user's activity. "never" for an empty value.
export function relativeAge(when: Date | null | undefined, now: Date = new Date()): string {
  if (!when) return 'never'
  const minutes = Math.max(0, Math.floor((now.getTime() - when.getTime()) / 60_000))
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}
