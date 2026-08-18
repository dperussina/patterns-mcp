/**
 * Ending a process without leaving its compiler behind.
 *
 * The verifier holds a `tsc` subprocess for the life of the process, and `close()` on the compiler API
 * drops the reference without waiting for the child to exit — so the only thing that actually ends it is
 * `disposeEngine`. Every exit path calls that already, except the one a host is most likely to use: a
 * signal. Node's default disposition ends this process immediately, the child is reparented to init, and
 * nothing ever reaps it.
 *
 * Measured rather than reasoned about. A machine that had been running the suite for a few days held 38
 * of them, every one parented to init, 261MB resident between them, the oldest three days old. CI found
 * the same thing from the other side: the gate passed in full and the job then sat for 73 minutes,
 * because an orphan still held the runner's output pipe and the step cannot end until that closes.
 *
 * This lives at the top level, beside `refusals.ts`, because both delivery surfaces need it and neither
 * owns the other. It is deliberately not in the engine: a library that installs global signal handlers
 * takes a decision belonging to whoever owns the process, which is the same reason the engine does not
 * install one for unhandled rejections either.
 */

import process from "node:process";

/**
 * The signals worth handling: the ones whose default disposition ends the process and which something
 * other than the kernel chose to send.
 *
 * `SIGKILL` is absent because it cannot be caught, which leaves one uncovered case — a host that skips
 * `SIGTERM` and goes straight to `SIGKILL` still orphans the compiler. Nothing portable fixes that from
 * inside the process, and it is not the case that was costing anything.
 */
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * How long disposal may take before the signal is honoured anyway.
 *
 * Disposal is a `close()` and a `kill()`, so this is orders of magnitude more room than it needs. It
 * exists because the alternative to a bounded wait is an unbounded one: a compiler wedged mid-check is
 * exactly when a signal arrives, and a handler that waited forever would convert "leaks a subprocess"
 * into "ignores Ctrl-C", which is worse.
 */
const GRACE_MS = 2_000;

/**
 * Disposes the engine when a signal asks this process to end, then dies of that signal.
 *
 * Re-raising rather than calling `process.exit` with a status of our own: installing a handler suppresses
 * the default disposition, so a caller that would have seen "terminated by SIGTERM" would instead see a
 * plain exit code, and a shell reporting why a process died would start lying. Removing our own listener
 * and sending the signal again restores exactly what would have happened without us, only later and with
 * the child gone.
 *
 * Idempotent under a repeated signal — an impatient second Ctrl-C is ignored rather than starting a
 * second disposal — and best-effort about failure, because a disposal that throws must not leave the
 * process ignoring the signal that prompted it.
 */
export function disposeOnSignal(dispose: () => Promise<void>): void {
  let ending = false;

  for (const signal of SIGNALS) {
    const listener = (): void => {
      if (ending) return;
      ending = true;

      void (async (): Promise<void> => {
        await Promise.race([dispose().catch(() => undefined), grace()]);
        process.off(signal, listener);
        process.kill(process.pid, signal);
      })();
    };

    process.on(signal, listener);
  }
}

/** Resolves after the grace period, without holding the event loop open on its own account. */
function grace(): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, GRACE_MS);
    timer.unref?.();
  });
}
