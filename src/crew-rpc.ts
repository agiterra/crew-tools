import {
  RpcClient,
  WireConnection,
  derivePublicKeyB64,
  importPrivateKey,
} from "@agiterra/wire-tools";
import { CrewStore } from "./store.js";

export type CrewRpcWriter = {
  readonly dest: string;
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  requestTo(dest: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  stop(): Promise<void>;
};

export type CrewRpcWriterOptions = {
  dbPath?: string;
  dest?: string;
  url?: string;
  agentId?: string;
  privateKeyB64?: string;
  defaultTimeoutMs?: number;
};

function resolveDest(opts: CrewRpcWriterOptions): string {
  if (opts.dest) return opts.dest;
  if (process.env.CREW_SVC_DEST) return process.env.CREW_SVC_DEST;
  if (process.env.CREW_RPC_DEST) return process.env.CREW_RPC_DEST;
  const store = new CrewStore(opts.dbPath);
  return `crew-svc@${store.localMachineName()}`;
}

export async function createCrewRpcWriter(opts: CrewRpcWriterOptions = {}): Promise<CrewRpcWriter> {
  const agentId = opts.agentId ?? process.env.CREW_RPC_AGENT_ID ?? process.env.AGENT_ID;
  const privateKeyB64 = opts.privateKeyB64 ?? process.env.CREW_RPC_PRIVATE_KEY ?? process.env.AGENT_PRIVATE_KEY;
  if (!agentId || !privateKeyB64) {
    throw new Error("crew RPC writer requires AGENT_ID and AGENT_PRIVATE_KEY (or CREW_RPC_AGENT_ID/CREW_RPC_PRIVATE_KEY)");
  }

  const url = opts.url ?? process.env.WIRE_URL ?? "http://localhost:9800";
  const privateKey = await importPrivateKey(privateKeyB64);
  const publicKey = await derivePublicKeyB64(privateKey);
  const dest = resolveDest(opts);
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;

  // grok-wire-bridge already holds AGENT_ID's Wire SSE. A second
  // WireConnection as the same id — even one-shot — is still two SSEs
  // (dashboard multi-session; RPC replies land on the bridge session).
  // crew-service HTTP MCP is READ-ONLY (AGI-27). Spawn RPC must ride the
  // existing bridge connection, not open another SSE.
  if (process.env.GROK_WIRE_BRIDGE === "1") {
    throw new Error(
      "GROK_WIRE_BRIDGE=1: do not open a second Wire SSE as AGENT_ID. " +
      "Spawn/RPC must use grok-wire-bridge's existing connection (or crew-service HTTP writes when those land).",
    );
  }

  const client = new RpcClient({
    url,
    agentId,
    signingKey: privateKey,
    defaultTimeoutMs,
  });
  const conn = new WireConnection({
    url,
    agentId,
    agentName: agentId,
    keyPair: { publicKey, privateKey },
    ccSessionId: `crew-tools-rpc-${process.pid}`,
    deliver: async ({ raw }) => {
      client.handleEvent(raw);
    },
  });

  await conn.start();
  return {
    dest,
    request: (method, params, timeoutMs) => client.request(dest, method, params, timeoutMs),
    requestTo: (target, method, params, timeoutMs) => client.request(target, method, params, timeoutMs),
    stop: () => conn.stop(),
  };
}
