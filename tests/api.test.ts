import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/auth", () => ({ auth: vi.fn(), ownerId: () => "owner" }));
vi.mock("@/lib/db", () => ({
  sql: vi.fn(() => {
    throw new Error("Database should not be reached");
  }),
}));
import { auth } from "@/auth";
import { GET, POST } from "@/app/api/[...path]/route";
const context = { params: Promise.resolve({ path: ["sync"] }) };
beforeEach(() => {
  vi.resetAllMocks();
  process.env.ALLOWED_EMAIL = "owner@example.com";
});
describe("private API boundaries", () => {
  it("rejects unauthenticated reads before database access", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    expect(
      (await GET(new Request("http://localhost:3003/api/sync"), context))
        .status,
    ).toBe(401);
  });
  it("rejects a non-owner session", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { email: "other@example.com" },
    } as never);
    expect(
      (await GET(new Request("http://localhost:3003/api/sync"), context))
        .status,
    ).toBe(401);
  });
  it("rejects cross-origin writes", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { email: "owner@example.com" },
    } as never);
    expect(
      (
        await POST(
          new Request("http://localhost:3003/api/sync", {
            method: "POST",
            headers: { origin: "https://evil.example" },
            body: "{}",
          }),
          context,
        )
      ).status,
    ).toBe(403);
  });
  it("rejects malformed writes before database access", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { email: "owner@example.com" },
    } as never);
    const response = await POST(
      new Request("http://localhost:3003/api/sync", {
        method: "POST",
        headers: { origin: "http://localhost:3003" },
        body: "{}",
      }),
      context,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request" });
  });
});
