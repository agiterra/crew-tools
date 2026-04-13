import { describe, test, expect } from "bun:test";
import { generateKeyPair, exportPrivateKey, importPrivateKey, importKeyPair } from "./crypto";

describe("crypto", () => {
  test("generateKeyPair returns publicKey string and privateKey CryptoKey", async () => {
    const kp = await generateKeyPair();
    expect(typeof kp.publicKey).toBe("string");
    expect(kp.publicKey.length).toBeGreaterThan(0);
    expect(kp.privateKey).toBeInstanceOf(CryptoKey);
  });

  test("exportPrivateKey returns base64 string", async () => {
    const kp = await generateKeyPair();
    const exported = await exportPrivateKey(kp.privateKey);
    expect(typeof exported).toBe("string");
    expect(exported.length).toBeGreaterThan(0);
    // Should be valid base64
    expect(() => atob(exported)).not.toThrow();
  });

  test("importPrivateKey round-trips with exportPrivateKey", async () => {
    const kp = await generateKeyPair();
    const exported = await exportPrivateKey(kp.privateKey);
    const imported = await importPrivateKey(exported);
    expect(imported).toBeInstanceOf(CryptoKey);
    // Re-export should produce the same base64
    const reExported = await exportPrivateKey(imported);
    expect(reExported).toBe(exported);
  });

  test("importKeyPair returns matching publicKey", async () => {
    const kp = await generateKeyPair();
    const exported = await exportPrivateKey(kp.privateKey);
    const reimported = await importKeyPair(exported);
    expect(reimported.publicKey).toBe(kp.publicKey);
  });

  test("two generateKeyPair calls produce different keys", async () => {
    const kp1 = await generateKeyPair();
    const kp2 = await generateKeyPair();
    expect(kp1.publicKey).not.toBe(kp2.publicKey);
  });
});
