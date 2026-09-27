import { describe, expect, it } from "vitest";
import { HttpStatusError } from "../src/plugins/http-error";
import { syncErrorCode } from "../src/runtime/cycle";

describe("syncErrorCode", () => {
  it("names timeouts and aborts instead of leaking DOMException's numeric code", () => {
    expect(syncErrorCode(new DOMException("timed out", "TimeoutError"))).toBe("timeout");
    expect(syncErrorCode(new DOMException("aborted", "AbortError"))).toBe("aborted");
  });

  it("turns HTTP statuses into auth or http_<status> codes", () => {
    expect(syncErrorCode(new HttpStatusError(401, "no"))).toBe("unauthorized");
    expect(syncErrorCode(new HttpStatusError(403, "no"))).toBe("unauthorized");
    expect(syncErrorCode(new HttpStatusError(503, "down"))).toBe("http_503");
  });

  it("keeps string codes, and falls back for network and unknown failures", () => {
    expect(syncErrorCode(Object.assign(new Error("x"), { code: "mcp_unauthorized" }))).toBe("mcp_unauthorized");
    expect(syncErrorCode(new TypeError("fetch failed"))).toBe("network");
    expect(syncErrorCode(new Error("boom"))).toBe("sync_failed");
  });
});
