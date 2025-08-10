const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;




app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Proxy to Python OpenCV backend if available
const PY_BACKEND = process.env.PY_BACKEND || 'http://127.0.0.1:8000';

function proxyJson(toPath) {
  return async (req, res) => {
    try {
      const url = new URL(toPath, PY_BACKEND).toString();
      const payload = JSON.stringify(req.body || {});
      const u = new URL(url);
      const options = {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + (u.search || ''),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };
      const isHttps = u.protocol === 'https:';
      const client = isHttps ? require('https') : require('http');
      const pReq = client.request(options, pRes => {
        let data = '';
        pRes.on('data', chunk => (data += chunk));
        pRes.on('end', () => {
          res.status(pRes.statusCode || 500).type('application/json').send(data);
        });
      });
      pReq.on('error', err => {
        res.status(502).json({ ok: false, detail: 'Python 后端不可用', error: String(err) });
      });
      pReq.write(payload);
      pReq.end();
    } catch (e) {
      res.status(500).json({ ok: false, detail: '代理失败', error: String(e) });
    }
  };
}

app.post('/cv/register', proxyJson('/register'));
app.post('/cv/recognize', proxyJson('/recognize'));

function proxyGet(toPath) {
  return async (_req, res) => {
    try {
      const url = new URL(toPath, PY_BACKEND).toString();
      const u = new URL(url);
      const isHttps = u.protocol === 'https:';
      const client = isHttps ? require('https') : require('http');
      const options = {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + (u.search || ''),
        method: 'GET'
      };
      const pReq = client.request(options, pRes => {
        let data = '';
        pRes.on('data', chunk => (data += chunk));
        pRes.on('end', () => {
          res.status(pRes.statusCode || 500).type('application/json').send(data);
        });
      });
      pReq.on('error', err => {
        res.status(502).json({ ok: false, detail: 'Python 后端不可用', error: String(err) });
      });
      pReq.end();
    } catch (e) {
      res.status(500).json({ ok: false, detail: '代理失败', error: String(e) });
    }
  };
}

app.get('/cv/people', proxyGet('/people'));

// 健康检查
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'node-proxy', py_backend: PY_BACKEND });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});


