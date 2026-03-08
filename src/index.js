const express = require('express');
const Redis = require('ioredis');
const pino = require('pino');
const pinoHttp = require('pino-http');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const app = express();

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
});

redis.on('connect', () => logger.info('Redis connected'));
redis.on('error', (err) => logger.error({ err }, 'Redis error'));

app.use(express.json());
app.use(pinoHttp({ logger }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', build: process.env.BUILD_SHA || 'dev' });
});

app.post('/cache', async (req, res) => {
  const { key, value, ttl = 3600 } = req.body;
  if (!key || !value) return res.status(400).json({ error: 'key and value required' });
  await redis.set(key, JSON.stringify(value), 'EX', ttl);
  req.log.info({ key }, 'Cache set');
  res.json({ success: true });
});

app.get('/cache/:key', async (req, res) => {
  const { key } = req.params;
  const value = await redis.get(key);
  if (!value) return res.status(404).json({ error: 'Key not found' });
  req.log.info({ key }, 'Cache hit');
  res.json({ key, value: JSON.parse(value) });
});

app.delete('/cache/:key', async (req, res) => {
  const { key } = req.params;
  await redis.del(key);
  req.log.info({ key }, 'Cache deleted');
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => logger.info({ port: PORT }, 'Server started'));

let shuttingDown = false;

async function shutdown(err) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (err) {
    logger.fatal({ err }, 'Fatal error, shutting down');
  } else {
    logger.info('Shutdown signal received');
  }

  server.close(async () => {
    logger.info('HTTP server closed');

    try {
      await redis.quit();
      logger.info('Redis connection closed');
    } catch (e) {
      logger.error({ err: e }, 'Error closing Redis');
    }

    process.exit(err ? 1 : 0);
  });

  setTimeout(() => {
    logger.fatal('Forcefully shutting down');
    process.exit(1);
  }, 5000).unref();
}

process.on('uncaughtException', shutdown);

process.on('unhandledRejection', (reason) => {
  shutdown(reason);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);