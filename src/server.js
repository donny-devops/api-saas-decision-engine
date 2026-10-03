const express = require("express");
const path = require("path");
const { evaluateDecision } = require("./decisionEngine");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    app: "api-saas-decision-engine",
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/decide", (req, res) => {
  const result = evaluateDecision(req.body || {});
  res.json(result);
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`api-saas-decision-engine listening on http://localhost:${PORT}`);
  });
}
