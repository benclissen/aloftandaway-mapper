/** A failure in what Mapper needs around it (Chrome, ffmpeg, the network), not in Mapper. `fix` says what to do. */
export class EnvironmentError extends Error {
  readonly fix: string

  constructor(message: string, fix: string) {
    super(message)
    this.name = 'EnvironmentError'
    this.fix = fix
  }
}

/** The fix an error carries, if it is an `Error` with a non-empty string `fix`, as Mapper's own error classes have. */
export function fixOf(e: unknown): string | undefined {
  if (!(e instanceof Error)) return undefined
  const fix = (e as { fix?: unknown }).fix
  return typeof fix === 'string' && fix ? fix : undefined
}
