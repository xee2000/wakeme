import 'dotenv/config';
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: 'https://c92c017959b209c2ab91e44f99fa5f85@o4511272556953600.ingest.us.sentry.io/4511272557346816',
  sendDefaultPii: true,
  tracesSampleRate: 1.0, // 100% 트랜잭션 추적 (운영 시 0.2 정도로 낮추세요)
});

import { EventEmitter } from 'events';
EventEmitter.defaultMaxListeners = 30;
import express from 'express';
import cors from 'cors';

import fs from 'fs';
import path from 'path';
import busRouter from './routes/bus';
import notifyRouter from './routes/notify';
import stopsRouter from './routes/stops';
import subwayRouter from './routes/subway';
import { initRouteCache } from './lib/routeCache';
import { logger } from './lib/logger';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

// ── 미들웨어 ─────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── 헬스체크 ─────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── 로그 조회 (최근 N줄) ─────────────────────────────────────────
app.get('/logs', (_req, res) => {
  try {
    const logDir = path.resolve(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) {
      res.json({ lines: [], message: '로그 없음' });
      return;
    }
    const files = fs.readdirSync(logDir).sort().reverse(); // 최신 날짜 먼저
    if (files.length === 0) { res.json({ lines: [] }); return; }

    const today = files[0];
    const content = fs.readFileSync(path.join(logDir, today), 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean).reverse().slice(0, 200);
    res.json({ file: today, lines });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── API 라우터 ────────────────────────────────────────────────────
app.use('/api/bus', busRouter);
app.use('/api/notify', notifyRouter);
app.use('/api/stops', stopsRouter);
app.use('/api/subway', subwayRouter);

// ── 404 ──────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// ── Sentry 에러 핸들러 (반드시 라우터 뒤, 글로벌 핸들러 앞) ────────
Sentry.setupExpressErrorHandler(app);

// ── 글로벌 에러 핸들러 ────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('SERVER', `미처리 에러: ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: '서버 내부 오류' });
});

app.listen(PORT, () => {
  logger.info('SERVER', `WakeMe 서버 시작 → http://localhost:${PORT}`);
  initRouteCache().catch(err => {
    logger.error('SERVER', `routeCache 초기화 실패: ${err.message}`);
  });
});

export default app;
