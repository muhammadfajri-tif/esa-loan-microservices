 import express, { Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import axios from 'axios';

// ==============================
// CONFIG
// ==============================
const LOAN_CORE_SERVERS = (
  process.env.LOAN_CORE_SERVERS ||
  'http://localhost:3001,http://localhost:3002'
).split(',');

const AUDIT_URL = process.env.AUDIT_URL || 'http://localhost:3010';
const PORT = Number(process.env.PORT || 3000);

// ==============================
// APP INIT
// ==============================
const app = express();
app.use(cors());
app.use(bodyParser.json());

// ==============================
// SIMPLE LOGGER
// ==============================
const log = (msg: string, meta?: any) => {
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    service: 'api-gateway',
    message: msg,
    ...meta
  }));
};

// ==============================
// [NEW FEATURE] RATE LIMITER
// ==============================
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60);
const RATE_WINDOW_MS = 60_000; // 1 menit

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

// Cleanup expired entries every 5 minutes to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore.entries()) {
    if (now > entry.resetAt) {
      rateLimitStore.delete(ip);
    }
  }
}, 5 * 60_000);

function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();

  let entry = rateLimitStore.get(ip);

  // Reset window jika sudah expired
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateLimitStore.set(ip, entry);
  }

  entry.count++;

  // Set standard rate limit response headers
  res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT_MAX - entry.count));
  res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000));

  if (entry.count > RATE_LIMIT_MAX) {
    const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);
    log('Rate limit exceeded', { ip, count: entry.count, limit: RATE_LIMIT_MAX });

    res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Maximum ${RATE_LIMIT_MAX} requests per minute allowed.`,
      retryAfter: retryAfterSeconds
    });
    return;
  }

  next();
}

// Terapkan ke semua routes
app.use(rateLimitMiddleware);

// ==============================
// LOAD BALANCER (ROUND ROBIN)
// ==============================
let loanIndex = 0;

function getLoanService() {
  const url = LOAN_CORE_SERVERS[loanIndex];
  loanIndex = (loanIndex + 1) % LOAN_CORE_SERVERS.length;
  return url;
}

// ==============================
// HEALTH CHECK (MULTI INSTANCE)
// ==============================
app.get('/health', async (_req, res) => {
  try {
    const loanChecks = await Promise.all(
      LOAN_CORE_SERVERS.map(url =>
        axios.get(url + '/loans/health', { timeout: 2000 })
          .then(r => ({ url, status: r.data }))
          .catch(() => ({ url, status: 'down' }))
      )
    );

    const audit = await axios
      .get(AUDIT_URL + '/health', { timeout: 2000 })
      .catch(() => null);

    res.json({
      status: 'ok',
      loanInstances: loanChecks,
      audit: audit?.data || 'unavailable'
    });

  } catch (err) {
    res.status(500).json({ status: 'error', error: String(err) });
  }
});

// ==============================
// LOAN APPLY (WITH LOAD BALANCING)
// ==============================
app.post('/api/loans/apply', async (req: Request, res: Response) => {
  const payload = req.body;
  const target = getLoanService();

  try {
    log('Forwarding loan request', { target });

    const r = await axios.post(
      target + '/loans/apply',
      payload,
      { timeout: 60000 }
    );

    res.json(r.data);

  } catch (err: any) {
    log('Loan service error', { target, error: err?.toString() });

    res.status(500).json({
      error: err?.toString(),
      target,
      details: err?.response?.data || null
    });
  }
});

// ==============================
// AUDIT SERVICE (NO LB)
// ==============================
app.get('/api/audit/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const r = await axios.get(
      `${AUDIT_URL}/audit/${encodeURIComponent(id)}`,
      { timeout: 5000 }
    );

    res.json(r.data);

  } catch (err: any) {
    if (err.response?.status === 404) {
      return res.status(404).json({ error: 'not found' });
    }

    res.status(500).json({ error: String(err) });
  }
});

// ==============================
// START SERVER
// ==============================
const server = app.listen(PORT, () => {
  log('API Gateway started', {
    port: PORT,
    loanServices: LOAN_CORE_SERVERS,
    auditService: AUDIT_URL
  });
});

// ==============================
// HANDLE STARTUP ERROR
// ==============================
server.on('error', (err) => {
  log('Startup error', { error: err });
  process.exit(1);
});

// ==============================
// GRACEFUL SHUTDOWN
// ==============================
const shutdown = (signal: string) => {
  log('Shutdown signal received', { signal });

  server.close(() => {
    log('Server closed gracefully');
    process.exit(0);
  });

  setTimeout(() => {
    log('Force shutdown');
    process.exit(1);
  }, 5000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);