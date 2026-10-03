const express = require("express");
const rateLimit = require("express-rate-limit");
const path = require("path");
const { evaluateDecision } = require("./decisionEngine");

const app = express();
const PORT = process.env.PORT || 3000;

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

const publicDir = path.join(__dirname, "..", "public");

app.use(express.json());
app.use("/", apiLimiter, express.static(publicDir));

app.get("/health", apiLimiter, (req, res) => {
  res.json({
    status: "ok",
    app: "api-saas-decision-engine",
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/decide", apiLimiter, (req, res) => {
  const result = evaluateDecision(req.body || {});
  res.json(result);
});

app.get("/", apiLimiter, (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
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
