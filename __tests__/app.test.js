const request = require("supertest");
const app = require("../src/server");

describe("api-saas-decision-engine", () => {
  test("health endpoint reports ok", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.app).toBe("api-saas-decision-engine");
  });

  test("decision endpoint returns a recommendation", async () => {
    const response = await request(app)
      .post("/api/decide")
      .send({
        customerTier: "enterprise",
        monthlyRevenue: 90000,
        contractLength: 24,
        teamSize: 150,
        region: "us",
        riskScore: 20,
      });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.score).toBeGreaterThanOrEqual(80);
    expect(response.body.recommendation).toBe("Accelerate expansion");
    expect(response.body.fit).toBe("strong");
  });
});
