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

  // grok-wire-bridge already holds AGENT_ID's Wire SSE. A long-lived second
  // WireConnection is another dashboard session. crew-service HTTP MCP is
  // READ-ONLY (AGI-27) and cannot spawn. Under GROK_WIRE_BRIDGE=1 open a
  // one-shot SSE per RPC and close it after — no persistent extra session.
  const oneshot = process.env.GROK_WIRE_BRIDGE === "1";

  const makeClient = () =>
    new RpcClient({
      url,
      agentId,
      signingKey: privateKey,
      defaultTimeoutMs,
    });

  if (oneshot) {
    const run = async (
      target: string,
      method: string,
      params: unknown,
      timeoutMs?: number,
    ): Promise<unknown> => {
      const client = makeClient();
      const conn = new WireConnection({
        url,
        agentId,
        agentName: agentId,
        keyPair: { publicKey, privateKey },
        ccSessionId: `crew-rpc-oneshot-${process.pid}-${Date.now()}`,
        deliver: async ({ raw }) => {
          client.handleEvent(raw);
        },
      });
      await conn.start();
      try {
        return await client.request(target, method, params, timeoutMs);
      } finally {
        await conn.stop();
      }
    };
    return {
      dest,
      request: (method, params, timeoutMs) => run(dest, method, params, timeoutMs),
      requestTo: (target, method, params, timeoutMs) => run(target, method, params, timeoutMs),
      stop: async () => {},
    };
  }

  const client = makeClient();
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
