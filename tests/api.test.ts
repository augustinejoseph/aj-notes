import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/auth", () => ({ auth: vi.fn(), ownerId: () => "owner" }));
vi.mock("@/lib/remote-image", () => ({ fetchRemoteImage: vi.fn() }));
vi.mock("@/lib/db", () => ({
  sql: vi.fn(() => {
    throw new Error("Database should not be reached");
  }),
}));
import { auth } from "@/auth";
import { fetchRemoteImage } from "@/lib/remote-image";
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

describe("image import API", () => {
  const imageContext = { params: Promise.resolve({ path: ["image-import"] }) };
  const makeRequest = (
    origin = "http://localhost:3003",
    body = JSON.stringify({ url: "https://example.com/image.png" }),
  ) =>
    new Request("http://localhost:3003/api/image-import", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body,
    });
  it("requires an authenticated owner and same-origin request before fetching", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await POST(makeRequest(), imageContext)).status).toBe(401);
    vi.mocked(auth).mockResolvedValue({
      user: { email: "owner@example.com" },
    } as never);
    expect(
      (await POST(makeRequest("https://other.example"), imageContext)).status,
    ).toBe(403);
    expect(fetchRemoteImage).not.toHaveBeenCalled();
  });
  it("returns imported bytes and rejects malformed URLs", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { email: "owner@example.com" },
    } as never);
    vi.mocked(fetchRemoteImage).mockResolvedValue(
      new Response("image", { headers: { "Content-Type": "image/png" } }),
    );
    const response = await POST(makeRequest(), imageContext);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.text()).toBe("image");
    expect(fetchRemoteImage).toHaveBeenCalledWith(
      "https://example.com/image.png",
    );
    expect(
      (await POST(makeRequest(undefined, '{"url":"invalid"}'), imageContext))
        .status,
    ).toBe(400);
    expect(fetchRemoteImage).toHaveBeenCalledTimes(1);
  });
});
