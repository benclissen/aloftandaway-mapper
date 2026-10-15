declare module 'fontnik' {
  export function range(
    options: { font: Buffer; start: number; end: number },
    callback: (error: Error | null, pbf: Buffer) => void,
  ): void
}
