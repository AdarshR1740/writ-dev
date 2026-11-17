import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("./supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a), from: vi.fn() } }));

import { withShortLock } from "./locks";

const PIECE = "22222222-2222-4222-8222-222222222222";

describe("a one-off write under a lock", () => {
  beforeEach(() => rpc.mockReset());

  it("takes the lock, runs the write and lets go with the token it was given", async () => {
    rpc.mockResolvedValueOnce({ data: { ok: true, token: "tok-1", expires_at: "2099-01-01T00:00:00Z" }, error: null }).mockResolvedValue({ data: null, error: null });
    expect(await withShortLock(PIECE, "scope", async () => "saved")).toBe("saved");
    expect(rpc.mock.calls[0][0]).toBe("acquire_lock");
    expect(rpc.mock.calls[0][1]).toMatchObject({ target_piece: PIECE, lock_scope: "scope", target_section: null, kind: "person" });
    expect(rpc.mock.calls[1][0]).toBe("release_lock");
    expect(rpc.mock.calls[1][1]).toMatchObject({ lock_scope: "scope", lock_token: "tok-1" });
  });

  it("writes nothing and says who holds it when someone else does", async () => {
    rpc.mockResolvedValueOnce({ data: { ok: false, holder_label: "Claude (for Adarsh)", holder_kind: "ai", since: "2026-11-16T10:02:00Z", expires_at: "x" }, error: null });
    let ran = false;
    await expect(withShortLock(PIECE, "research", async () => { ran = true; })).rejects.toThrow(/Claude \(for Adarsh\) is editing the research/);
    expect(ran).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("lets go when the write fails", async () => {
    rpc.mockResolvedValueOnce({ data: { ok: true, token: "t", expires_at: "2099-01-01T00:00:00Z" }, error: null }).mockResolvedValue({ data: null, error: null });
    await expect(withShortLock(PIECE, "final", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["acquire_lock", "release_lock"]);
  });

  it("takes a lock once when short locks on it overlap, so the inner one cannot let go of the outer one", async () => {
    rpc.mockResolvedValueOnce({ data: { ok: true, token: "t", expires_at: "2099-01-01T00:00:00Z" }, error: null }).mockResolvedValue({ data: null, error: null });
    await withShortLock(PIECE, "research", () => withShortLock(PIECE, "research", async () => undefined));
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["acquire_lock", "release_lock"]);
  });

  it("runs the write when the database has no lock functions yet", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function public.acquire_lock" } });
    expect(await withShortLock(PIECE, "scope", async () => 7)).toBe(7);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
