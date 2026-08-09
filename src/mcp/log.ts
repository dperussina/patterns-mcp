/**
 * Where diagnostics go.
 *
 * On stdio, stdout is the wire, so anything written there that is not a JSON-RPC frame corrupts the
 * message stream. stderr is therefore the only safe destination for a diagnostic, and treating it as
 * the default everywhere means no code path has to know which transport it is running under.
 *
 * This exists as its own module rather than living in the transport because the error mapper needs it
 * too: a correlation identifier handed to a caller is worthless unless the detail it refers to was
 * recorded somewhere (FR-038). The mapper importing a transport to get a logger would invert the
 * dependency for no reason.
 */

export type Logger = (line: string) => void;

/**
 * Writes a diagnostic to stderr.
 *
 * `process.stderr.write` rather than `console.error`, because the stdio entry rewrites `console` to
 * point here and a `console.error` in this function would then call itself.
 */
export function stderrLog(line: string): void {
  process.stderr.write(`${line}\n`);
}
