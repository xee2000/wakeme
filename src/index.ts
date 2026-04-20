import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import busRouter from './routes/bus';
import notifyRouter from './routes/notify';
import stopsRouter from './routes/stops';
import { initRouteCache } from './lib/routeCache';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

// ── 미들웨어 ─────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── 헬스체크 ─────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── API 라우터 ────────────────────────────────────────────────────
app.use('/api/bus', busRouter);
app.use('/api/notify', notifyRouter);
app.use('/api/stops', stopsRouter);

// ── 404 ──────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// ── 글로벌 에러 핸들러 ────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: '서버 내부 오류' });
});

app.listen(PORT, () => {
  console.log(`✅ WakeMe 서버 실행 중 → http://localhost:${PORT}`);
  // 노선 캐시 초기화 (백그라운드 — 서버 응답은 바로 가능)
  initRouteCache().catch(err => console.error('[routeCache] 초기화 실패:', err));
});

export default app;
