import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("account extension contract", () => {
  const route = fs.readFileSync(path.resolve("src/modules/account.routes.ts"), "utf8");
  const schema = fs.readFileSync(path.resolve("prisma/schema.prisma"), "utf8");
  it("registers profile, password recovery, and notification endpoints", () => {
    for (const endpoint of [
      'app.patch("/api/users/me"',
      'app.post("/api/auth/password/reset/request"',
      'app.post("/api/auth/password/reset/confirm"',
      'app.post("/api/auth/password/login"',
      'app.get("/api/notifications"',
      'app.patch("/api/notifications/:id/read"',
      'app.post("/api/notifications/read-all"'
    ]) expect(route).toContain(endpoint);
  });
  it("stores password hashes and notification ownership in the schema", () => {
    expect(schema).toContain("passwordHash          String?");
    expect(schema).toContain("model Notification");
    expect(schema).toContain('onDelete: Cascade');
  });
  it("does not expose a pretend-success money or incentive API", () => {
    expect(route).toContain("paymentIntents:false");
    expect(route).toContain("depositPayout:false");
    expect(route).toContain("bonuses:false");
    expect(route).toContain("agentCommissions:false");
  });
});
