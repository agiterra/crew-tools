import { createConnection } from "net";
import { join } from "path";
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

  // grok-wire already holds AGENT_ID's Wire SSE. Do not open another.
  // MCP children send RPC through the sidecar unix hatch, which signs
  // rpc.request on the existing connection and correlates rpc.reply.
  if (process.env.GROK_WIRE_BRIDGE === "1") {
    const sock =
      process.env.GROK_RPC_SOCK ??
      join(process.env.HOME ?? "/tmp", ".wire", "grok-bridge", `${agentId}.rpc.sock`);
    const destFixed = dest;
    const call = (target: string, method: string, params: unknown, timeoutMs?: number) =>
      new Promise<unknown>((resolve, reject) => {
        const c = createConnection(sock);
        let buf = "";
        const timer = setTimeout(() => {
          c.destroy();
          reject(new Error(`GROK_RPC_SOCK ${method} to ${target} timed out after ${timeoutMs ?? 120000}ms`));
        }, timeoutMs ?? 120_000);
        c.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        c.on("data", (chunk) => {
          buf += chunk.toString();
          if (!buf.includes("\n")) return;
          clearTimeout(timer);
          try {
            const msg = JSON.parse(buf.split("\n")[0]) as { ok?: boolean; result?: unknown; error?: string };
            if (msg.ok) resolve(msg.result);
            else reject(new Error(msg.error ?? "rpc-hatch error"));
          } catch (e) {
            reject(e as Error);
          } finally {
            c.end();
          }
        });
        c.write(JSON.stringify({ dest: target, method, params, timeoutMs: timeoutMs ?? 120000 }) + "\n");
      });
    return {
      dest: destFixed,
      request: (method, params, timeoutMs) => call(destFixed, method, params, timeoutMs),
      requestTo: (target, method, params, timeoutMs) => call(target, method, params, timeoutMs),
      stop: async () => {},
    };
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
