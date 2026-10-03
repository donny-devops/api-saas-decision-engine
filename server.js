const http = require('node:http');
const { URL } = require('node:url');
const { evaluateDecision, generateSampleInput } = require('./src/decision-engine');

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('Request body is not valid JSON.'));
      }
    });

    req.on('error', reject);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const method = req.method.toUpperCase();

    if (method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        service: 'api-saas-decision-engine',
        version: '1.0.0'
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/decisions/sample') {
      sendJson(res, 200, { sampleInput: generateSampleInput() });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/decisions/evaluate') {
      try {
        const payload = await parseJsonBody(req);
        const decision = evaluateDecision(payload);
        sendJson(res, 200, decision);
      } catch (error) {
        sendJson(res, 400, {
          error: error.message || 'Unable to evaluate decision.'
        });
      }
      return;
    }

    sendJson(res, 404, {
      error: 'Not found',
      path: url.pathname
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => {
    console.log(`api-saas-decision-engine listening on http://localhost:${port}`);
  });
}

module.exports = {
  createServer,
  evaluateDecision,
  generateSampleInput
};
