/**
 * Auto-sponsor child agents on Wire.
 *
 * When crew.agent_launch spawns a new agent without an explicit private key
 * in env, we check whether the crew MCP process itself has a Wire identity
 * (CREW_PRIVATE_KEY / WIRE_PRIVATE_KEY + AGENT_ID in its own env). If it
 * does, we generate a fresh Ed25519 keypair for the child, pre-register the
 * pubkey on Wire under the child's AGENT_ID using the parent as sponsor,
 * and inject the new private key into the child's spawn env as
 * CREW_PRIVATE_KEY — the name wire-tools' MCP actually reads.
 *
 * If no parent identity is available or registration fails, this module
 * returns null and the caller spawns the child without a Wire identity.
 * That matches today's behavior (the child's wire-tools MCP exits at
 * startup, screen-hardcopy IPC only) — no regression surface.
 *
 * Why CREW_PRIVATE_KEY and not AGENT_PRIVATE_KEY: wire-tools/mcp-server.ts
 * reads `process.env.CREW_PRIVATE_KEY ?? process.env.WIRE_PRIVATE_KEY`.
 * Setting AGENT_PRIVATE_KEY (as the orchestrator docs historically suggest)
 * results in wire-tools exiting with no_private_key. Inject under the name
 * that actually works.
 */

// Crypto-only subpath: pulls in nothing past Web Crypto. Importing the
// package root (or /http) pulls wire-tools' logger.ts, which depends on
// pino — pino isn't a crew-tools dependency, and `bun test` blows up
// loading it. We re-inline the four-line register POST below to stay
// pino-free.
import {
  generateKeyPair,
  exportPrivateKey,
  importKeyPair,
  createAuthJwt,
  type KeyPair,
} from "@agiterra/wire-tools/crypto";

/**
 * POST /agents/register with a Bearer JWT signed by the sponsor.
 * Inlined to avoid importing @agiterra/wire-tools/http (which pulls
 * pino through logger.ts). The wire daemon's auth gate accepts this
 * call when `requireAgent(c, sponsorId)` resolves the sponsor's pubkey
 * from the store.
 */
async function registerChildOnWire(
  url: string,
  sponsorAgentId: string,
  newAgentId: string,
  displayName: string,
  newPublicKeyB64: string,
  sponsorSigningKey: CryptoKey,
): Promise<void> {
  const body = JSON.stringify({ id: newAgentId, display_name: displayName, pubkey: newPublicKeyB64 });
  const token = await createAuthJwt(sponsorSigningKey, sponsorAgentId, body);
  const res = await fetch(`${url}/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body,
  });
  if (!res.ok) {
    throw new Error(`Wire register failed (${res.status}): ${await res.text()}`);
  }
}

const DEFAULT_WIRE_URL = "http://localhost:9800";

export type SponsorIdentity = {
  agentId: string;
  keyPair: KeyPair;
  wireUrl: string;
};

/**
 * Read sponsor identity from the crew MCP process's own env. Returns null
 * if no usable identity is present (no key, no AGENT_ID, or key import
 * fails). Logged via console.error so it shows in MCP stderr.
 */
export async function readSponsorFromEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<SponsorIdentity | null> {
  const rawKey = env.CREW_PRIVATE_KEY ?? env.WIRE_PRIVATE_KEY ?? env.AGENT_PRIVATE_KEY;
  const agentId = env.AGENT_ID;
  if (!rawKey || !agentId) return null;
  try {
    const keyPair = await importKeyPair(rawKey);
    return {
      agentId,
      keyPair,
      wireUrl: env.WIRE_URL ?? DEFAULT_WIRE_URL,
    };
  } catch (e) {
    console.error(`[crew] autosponsor: failed to import parent key for sponsor '${agentId}':`, e);
    return null;
  }
}

/**
 * Generate a fresh Ed25519 keypair for `newAgentId`, register its pubkey
 * on Wire under that id sponsored by `sponsor`, and return the new
 * private key as base64 PKCS8 (ready to drop into the child's env as
 * CREW_PRIVATE_KEY).
 *
 * Returns null on any failure — registration rejected, wire down,
 * network error — so the caller can fall through to launching headless.
 * Failures are logged to stderr; we never throw upward.
 */
export async function sponsorChild(
  sponsor: SponsorIdentity,
  newAgentId: string,
  displayName: string,
): Promise<{ privateKeyB64: string } | null> {
  try {
    const childKeys = await generateKeyPair();
    await registerChildOnWire(
      sponsor.wireUrl,
      sponsor.agentId,
      newAgentId,
      displayName,
      childKeys.publicKey,
      sponsor.keyPair.privateKey,
    );
    const privateKeyB64 = await exportPrivateKey(childKeys.privateKey);
    console.error(
      `[crew] autosponsor: registered '${newAgentId}' on wire (sponsor='${sponsor.agentId}')`,
    );
    return { privateKeyB64 };
  } catch (e) {
    console.error(
      `[crew] autosponsor: failed to register '${newAgentId}' (sponsor='${sponsor.agentId}'): ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}
