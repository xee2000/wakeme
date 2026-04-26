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
import { XMLParser } from 'fast-xml-parser';
import { getStopsByRouteNo, isCacheReady } from '../lib/routeCache';
import { logger } from '../lib/logger';

const xmlParser = new XMLParser({ ignoreAttributes: false });

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
  const url = buildUrl(endpoint, params);
  try {
    const { data } = await axios.get(url, { timeout: 8000 });

    // 공공API 자체 오류코드 체크 (HTTP 200이어도 resultCode가 실패인 경우)
    const resultCode = data?.response?.header?.resultCode ?? data?.resultCode;
    const resultMsg  = data?.response?.header?.resultMsg  ?? data?.resultMsg ?? '';
    if (resultCode && resultCode !== '00' && resultCode !== 0) {
      logger.error('BUS_API', `${endpoint} 공공API 오류 (${Date.now() - t0}ms) code=${resultCode} msg=${resultMsg}`, { ...params, url });
      res.status(502).json({ success: false, error: `공공API 오류: ${resultMsg}`, code: resultCode });
      return;
    }

    const items = data?.response?.body?.items?.item ?? [];
    const count = Array.isArray(items) ? items.length : 1;
    logger.info('BUS_API', `${endpoint} 성공 (${Date.now() - t0}ms, ${count}건)`, params);
    res.json({ success: true, data: Array.isArray(items) ? items : [items] });
  } catch (err: any) {
    const elapsed = Date.now() - t0;
    const httpStatus  = err?.response?.status;
    const httpBody    = JSON.stringify(err?.response?.data ?? '').slice(0, 300);
    const isTimeout   = err.code === 'ECONNABORTED';

    logger.error('BUS_API', [
      `${endpoint} 실패 (${elapsed}ms)`,
      `message: ${err.message}`,
      `url: ${url}`,
      httpStatus ? `httpStatus: ${httpStatus}` : '',
      httpBody   ? `responseBody: ${httpBody}` : '',
      isTimeout  ? '⚠️ 타임아웃' : '',
    ].filter(Boolean).join(' | '), params);

    res.status(502).json({
      success: false,
      error: isTimeout ? '버스 API 타임아웃' : '버스 API 호출 실패',
      detail: err.message,
      ...(httpStatus && { httpStatus }),
    });
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

/**
 * 정류장 ID로 도착 예정 버스 조회
 * arsId(getArrInfoByUid) → 실패 시 BusStopID(getArrInfoByStopID) 순으로 시도
 *
 * GET /api/bus/arriving?nodeId=10390
 */
router.get('/arriving', async (req: Request, res: Response) => {
  const { nodeId } = req.query as Record<string, string>;
  if (!nodeId) { res.status(400).json({ error: 'nodeId 필수' }); return; }

  const arrivalBase = process.env.BUS_ARRIVAL_API_BASE!;
  const t0 = Date.now();

  // XML 파싱 후 버스 목록 추출. 결과 없으면 null 반환
  async function tryFetch(endpoint: string, paramKey: string): Promise<any[] | null> {
    const sp  = new URLSearchParams({ serviceKey: SERVICE_KEY, [paramKey]: nodeId });
    const url = `${arrivalBase}/${endpoint}?${sp.toString()}`;
    try {
      const { data: raw } = await axios.get(url, { timeout: 8000, responseType: 'text' });
      const parsed    = xmlParser.parse(raw);
      const headerCd  = String(parsed?.ServiceResult?.msgHeader?.headerCd ?? '0');
      if (headerCd !== '0') {
        logger.warn('BUS_API', `arriving ${endpoint} code=${headerCd}`, { nodeId });
        return null;
      }
      const rawItems = parsed?.ServiceResult?.msgBody?.itemList ?? [];
      const items: any[] = Array.isArray(rawItems) ? rawItems : [rawItems];
      return items.filter(b => b && b.ROUTE_NO).map(b => ({
        routeno:     String(b.ROUTE_NO ?? ''),
        arrtime:     Number(b.EXTIME_SEC ?? 0),
        arrtimeMin:  Number(b.EXTIME_MIN ?? 0),
        destination: String(b.DESTINATION ?? ''),
        stopName:    String(b.STOP_NAME ?? ''),
        vehicleno:   String(b.CAR_REG_NO ?? ''),
      }));
    } catch {
      return null;
    }
  }

  try {
    // 1차: BusStopID (Supabase bus_stops 기준 7자리 — 신규 경로)
    let buses = await tryFetch('getArrInfoByStopID', 'BusStopID');

    // 2차: arsId (구형 5자리 레거시 경로 폴백)
    if (!buses || buses.length === 0) {
      buses = await tryFetch('getArrInfoByUid', 'arsId');
    }

    logger.info('BUS_API', `arriving 완료 (${Date.now() - t0}ms) nodeId=${nodeId} → ${buses?.length ?? 0}대`);
    res.json({ success: true, data: buses ?? [] });
  } catch (err: any) {
    logger.error('BUS_API', `arriving 실패 (${Date.now() - t0}ms): ${err.message}`, { nodeId });
    res.status(502).json({ success: false, error: '도착정보 API 호출 실패', detail: err.message });
  }
});

/** 노선 ID로 버스 실시간 위치 조회 */
router.get('/positions', async (req: Request, res: Response) => {
  const { routeId } = req.query as Record<string, string>;
  if (!routeId) { res.status(400).json({ error: 'routeId 필수' }); return; }
  await proxyGet(res, 'getBusPosByRtidList', { routeId });
});

export default router;
