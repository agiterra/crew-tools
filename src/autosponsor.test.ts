import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { readSponsorFromEnv, sponsorChild } from "./autosponsor";
import { generateKeyPair, exportPrivateKey } from "@agiterra/wire-tools/crypto";

describe("readSponsorFromEnv", () => {
  test("returns null when no key is present", async () => {
    const id = await readSponsorFromEnv({ AGENT_ID: "x" });
    expect(id).toBeNull();
  });

  test("returns null when no AGENT_ID is present", async () => {
    const { privateKey } = await generateKeyPair();
    const b64 = await exportPrivateKey(privateKey);
    const id = await readSponsorFromEnv({ CREW_PRIVATE_KEY: b64 });
    expect(id).toBeNull();
  });

  test("returns null on garbage key, no throw", async () => {
    const id = await readSponsorFromEnv({
      AGENT_ID: "x",
      CREW_PRIVATE_KEY: "not-base64-pkcs8",
    });
    expect(id).toBeNull();
  });

  test("reads CREW_PRIVATE_KEY first, then WIRE_PRIVATE_KEY, then AGENT_PRIVATE_KEY", async () => {
    const { privateKey } = await generateKeyPair();
    const good = await exportPrivateKey(privateKey);

    // CREW wins over the other two.
    const a = await readSponsorFromEnv({
      AGENT_ID: "a",
      CREW_PRIVATE_KEY: good,
      WIRE_PRIVATE_KEY: "garbage",
      AGENT_PRIVATE_KEY: "garbage",
    });
    expect(a?.agentId).toBe("a");

    // WIRE wins when CREW absent.
    const b = await readSponsorFromEnv({
      AGENT_ID: "b",
      WIRE_PRIVATE_KEY: good,
      AGENT_PRIVATE_KEY: "garbage",
    });
    expect(b?.agentId).toBe("b");

    // AGENT used as last resort.
    const c = await readSponsorFromEnv({
      AGENT_ID: "c",
      AGENT_PRIVATE_KEY: good,
    });
    expect(c?.agentId).toBe("c");
  });

  test("defaults wireUrl to localhost:9800 and respects WIRE_URL override", async () => {
    const { privateKey } = await generateKeyPair();
    const b64 = await exportPrivateKey(privateKey);
    const def = await readSponsorFromEnv({ AGENT_ID: "x", CREW_PRIVATE_KEY: b64 });
    expect(def?.wireUrl).toBe("http://localhost:9800");
    const custom = await readSponsorFromEnv({
      AGENT_ID: "x",
      CREW_PRIVATE_KEY: b64,
      WIRE_URL: "http://wire.internal:7000",
    });
    expect(custom?.wireUrl).toBe("http://wire.internal:7000");
  });
});

describe("sponsorChild", () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("POSTs /agents/register with sponsor JWT and returns child key b64", async () => {
    const { privateKey } = await generateKeyPair();
    const sponsorKeyB64 = await exportPrivateKey(privateKey);
    const sponsor = await readSponsorFromEnv({ AGENT_ID: "sponsor-a", CREW_PRIVATE_KEY: sponsorKeyB64 });
    expect(sponsor).not.toBeNull();

    let capturedUrl = "";
    let capturedBody = "";
    let capturedAuth = "";
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = String(init?.body ?? "");
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuth = headers?.Authorization ?? "";
      return new Response("", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const result = await sponsorChild(sponsor!, "child-1", "Child One");
    expect(result).not.toBeNull();
    expect(result!.privateKeyB64.length).toBeGreaterThan(0);
    expect(capturedUrl).toBe("http://localhost:9800/agents/register");
    expect(capturedAuth).toMatch(/^Bearer /);
    const body = JSON.parse(capturedBody);
    expect(body.id).toBe("child-1");
    expect(body.display_name).toBe("Child One");
    expect(typeof body.pubkey).toBe("string");
    expect(body.pubkey.length).toBeGreaterThan(0);
  });

  test("returns null when wire rejects the registration", async () => {
    const { privateKey } = await generateKeyPair();
    const sponsorKeyB64 = await exportPrivateKey(privateKey);
    const sponsor = await readSponsorFromEnv({ AGENT_ID: "sponsor-b", CREW_PRIVATE_KEY: sponsorKeyB64 });

    globalThis.fetch = mock(async () => new Response("nope", { status: 401 })) as unknown as typeof globalThis.fetch;

    const result = await sponsorChild(sponsor!, "child-2", "Child Two");
    expect(result).toBeNull();
  });

  test("returns null when fetch throws (wire daemon down)", async () => {
    const { privateKey } = await generateKeyPair();
    const sponsorKeyB64 = await exportPrivateKey(privateKey);
    const sponsor = await readSponsorFromEnv({ AGENT_ID: "sponsor-c", CREW_PRIVATE_KEY: sponsorKeyB64 });

    globalThis.fetch = mock(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof globalThis.fetch;

    const result = await sponsorChild(sponsor!, "child-3", "Child Three");
    expect(result).toBeNull();
  });
});
