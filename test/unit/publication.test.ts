/**
 * The release identity, held together across the four files that state it (T090).
 *
 * Publication is the one operation here with no useful failure message. The MCP registry checks that
 * `server.json`'s name matches the `mcpName` in the published package, and that its version matches the
 * package's, and answers a mismatch with "Registry validation failed for package" — no field, no
 * expected value. Every check below exists because getting it wrong is silent until then, and because
 * two of the four files are JSON that no import can reach.
 *
 * The handshake is included for a different reason: it is what a client sees, and a server that
 * introduces itself under a name the registry does not list is one a user cannot connect back to the
 * entry they found it in.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SERVER_NAME, SERVER_TITLE, VERSION } from "../../src/version.js";

const ROOT = join(import.meta.dirname, "..", "..");

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly mcpName: string;
  readonly description: string;
  readonly bin: Readonly<Record<string, string>>;
  readonly files: readonly string[];
}

interface ServerRecord {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly packages: readonly {
    readonly registryType: string;
    readonly identifier: string;
    readonly version: string;
    readonly transport: { readonly type: string };
  }[];
}

async function read<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(join(ROOT, file), "utf8")) as T;
}

const manifest = await read<Manifest>("package.json");
const record = await read<ServerRecord>("server.json");
const npmPackage = record.packages[0];

describe("the registry record and the package", () => {
  it("agree on the server's name", () => {
    expect(record.name).toBe(manifest.mcpName);
  });

  it("agree on the version, which the registry compares to the published one", () => {
    expect(record.version).toBe(manifest.version);
    expect(npmPackage?.version).toBe(manifest.version);
  });

  it("point at the package that actually gets published", () => {
    expect(npmPackage?.registryType).toBe("npm");
    expect(npmPackage?.identifier).toBe(manifest.name);
  });

  it("describe a stdio server, which is the only transport implemented", () => {
    // `src/mcp/transports/` holds stdio alone. Advertising streamable HTTP here would send a client to
    // an endpoint that does not exist, and the registry cannot know that.
    expect(npmPackage?.transport.type).toBe("stdio");
  });

  it("keeps the description inside the registry's hundred characters", () => {
    expect(record.description.length).toBeLessThanOrEqual(100);
    expect(record.description).not.toBe("");
  });
});

describe("the handshake", () => {
  it("introduces the server under the name the registry lists", () => {
    expect(SERVER_NAME).toBe(manifest.mcpName);
  });

  it("carries a version equal to the package's, and a title fit to read", () => {
    expect(VERSION).toBe(manifest.version);
    expect(SERVER_TITLE).not.toContain("/");
  });
});

describe("what npm publishes", () => {
  it("ships the catalogue, without which every request fails", () => {
    // The engine reads `data/patterns/` at run time. Omitting it from `files` produced a package that
    // installed cleanly and answered nothing, which is what `pnpm smoke` now catches at build time.
    expect(manifest.files).toContain("data");
    expect(manifest.files).toContain("dist");
  });

  it("exposes the server as a binary a host can launch", () => {
    expect(Object.values(manifest.bin)).toContain(
      "./dist/mcp/transports/stdio-bin.mjs",
    );
  });

  it("says what it is, since npm shows this and nothing else by default", () => {
    expect(manifest.description).not.toBe("");
  });
});
