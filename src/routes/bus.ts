/**
 * 버스 API 프록시 라우터
 * 모바일 클라이언트가 서비스 키를 직접 보유하지 않아도 되도록 서버에서 대신 호출
 *
 * GET /api/bus/stops?routeNo=107          정류장 목록
 * GET /api/bus/arriving?nodeId=DJB123     도착 예정 버스
 * GET /api/bus/positions?routeId=DJB456   노선별 버스 위치
 */

import { Router, Request, Response } from 'express';
import axios from 'axios';
import { getStopsByRouteNo, isCacheReady } from '../lib/routeCache';
import { logger } from '../lib/logger';

const router = Router();

const BASE_URL = process.env.BUS_API_BASE!;
const SERVICE_KEY = process.env.BUS_SERVICE_KEY!;

function buildUrl(endpoint: string, params: Record<string, string>): string {
  const sp = new URLSearchParams({
    serviceKey: SERVICE_KEY,
    resultType: 'json',
    ...params,
  });
  return `${BASE_URL}/${endpoint}?${sp.toString()}`;
}

async function proxyGet(res: Response, endpoint: string, params: Record<string, string>) {
  const t0 = Date.now();
  try {
    const url = buildUrl(endpoint, params);
    const { data } = await axios.get(url, { timeout: 8000 });
    const items = data?.response?.body?.items?.item ?? [];
    const count = Array.isArray(items) ? items.length : 1;
    logger.info('BUS_API', `${endpoint} 성공 (${Date.now() - t0}ms, ${count}건)`, params);
    res.json({ success: true, data: Array.isArray(items) ? items : [items] });
  } catch (err: any) {
    logger.error('BUS_API', `${endpoint} 실패 (${Date.now() - t0}ms): ${err.message}`, params);
    res.status(502).json({ success: false, error: '버스 API 호출 실패' });
  }
}

/** 노선번호로 정류장 목록 조회 (routeCache 사용) */
router.get('/stops', async (req: Request, res: Response) => {
  const { routeNo } = req.query as Record<string, string>;
  if (!routeNo) { res.status(400).json({ error: 'routeNo 필수' }); return; }

  if (isCacheReady()) {
    const stops = getStopsByRouteNo(routeNo.trim());
    if (stops.length > 0) {
      logger.info('BUS_API', `stops 캐시 히트: routeNo=${routeNo} (${stops.length}개 정류장)`);
      res.json({ success: true, data: stops });
      return;
    }
    logger.warn('BUS_API', `stops 캐시 미스: routeNo=${routeNo} — 노선 없음`);
  } else {
    logger.warn('BUS_API', `stops 요청 — 캐시 미준비: routeNo=${routeNo}`);
  }

  res.json({ success: true, data: [], message: '노선 캐시에서 정류장을 찾을 수 없습니다.' });
});

/** 정류장 이름 검색 */
router.get('/search', async (req: Request, res: Response) => {
  const { name } = req.query as Record<string, string>;
  if (!name) { res.status(400).json({ error: 'name 필수' }); return; }
  await proxyGet(res, 'getNodeList', { nodeName: name, numOfRows: '30' });
});

/** GPS 좌표 기반 근처 정류장 조회 */
router.get('/nearby', async (req: Request, res: Response) => {
  const { lat, lng } = req.query as Record<string, string>;
  if (!lat || !lng) { res.status(400).json({ error: 'lat, lng 필수' }); return; }
  await proxyGet(res, 'getCrdntPrxmtSttnList', {
    gpsLati: lat,
    gpsLong: lng,
    numOfRows: '20',
  });
});

/** 정류장 ID로 도착 예정 버스 조회 */
router.get('/arriving', async (req: Request, res: Response) => {
  const { nodeId } = req.query as Record<string, string>;
  if (!nodeId) { res.status(400).json({ error: 'nodeId 필수' }); return; }
  await proxyGet(res, 'getSttnAcctoArvlPrearngeInfoList', { nodeId });
});

/** 노선 ID로 버스 실시간 위치 조회 */
router.get('/positions', async (req: Request, res: Response) => {
  const { routeId } = req.query as Record<string, string>;
  if (!routeId) { res.status(400).json({ error: 'routeId 필수' }); return; }
  await proxyGet(res, 'getBusPosByRtidList', { routeId });
});

export default router;
