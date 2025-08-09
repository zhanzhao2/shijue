const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, '..', 'data');
const PEOPLE_PATH = path.join(DATA_DIR, 'people.json');

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(PEOPLE_PATH)) {
    fs.writeFileSync(PEOPLE_PATH, JSON.stringify([] , null, 2), 'utf8');
  }
}

ensureDataFile();

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

app.get('/api/people', (req, res) => {
  try {
    const raw = fs.readFileSync(PEOPLE_PATH, 'utf8');
    const people = JSON.parse(raw);
    res.json({ people });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read people data' });
  }
});

app.post('/api/register', (req, res) => {
  try {
    const { name, descriptor } = req.body || {};
    if (!name || !descriptor || !Array.isArray(descriptor) || descriptor.length === 0) {
      return res.status(400).json({ error: 'Invalid payload. Expect { name, descriptor:number[] }' });
    }
    const raw = fs.readFileSync(PEOPLE_PATH, 'utf8');
    const people = JSON.parse(raw);
    // normalize name: trim and collapse spaces
    const normalizedName = String(name).trim().replace(/\s+/g, ' ');
    // Replace existing entry if name matches (case-insensitive)
    const existingIndex = people.findIndex(p => String(p.name).toLowerCase() === normalizedName.toLowerCase());
    const person = { name: normalizedName, descriptor };
    if (existingIndex >= 0) {
      people[existingIndex] = person;
    } else {
      people.push(person);
    }
    fs.writeFileSync(PEOPLE_PATH, JSON.stringify(people, null, 2), 'utf8');
    res.json({ ok: true, count: people.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save person' });
  }
});

app.delete('/api/people/:name', (req, res) => {
  try {
    const target = String(req.params.name || '').trim().toLowerCase();
    const raw = fs.readFileSync(PEOPLE_PATH, 'utf8');
    const people = JSON.parse(raw);
    const filtered = people.filter(p => String(p.name).toLowerCase() !== target);
    fs.writeFileSync(PEOPLE_PATH, JSON.stringify(filtered, null, 2), 'utf8');
    res.json({ ok: true, count: filtered.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete person' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});


