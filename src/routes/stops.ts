/**
 * 대전 버스 정류장 정적 데이터 API
 * 출처: 대전광역시_시내버스 기반정보_20250424.CSV (2,296개 정류장)
 *
 * GET /api/stops/search?name=중앙시장            이름 검색 (부분 일치)
 * GET /api/stops/nearby?lat=36.35&lng=127.38     GPS 기반 근처 정류장 (기본 반경 500m)
 * GET /api/stops/:stopId/routes                  정류장에 경유하는 노선 목록
 * GET /api/stops/cache/stats                     캐시 상태 확인 (디버그)
 */

import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { getRoutesByNodeIds, isCacheReady, getCacheStats } from '../lib/routeCache';

const router = Router();

interface Stop {
  id: string;
  nationalCode: string;
  settlementCode: string;
  name: string;
  district: string;
  dong: string;
  lat: number;
  lng: number;
}

// 서버 시작 시 JSON 1회 로드
const stopsPath = path.join(__dirname, '../data/stops.json');
const ALL_STOPS: Stop[] = JSON.parse(fs.readFileSync(stopsPath, 'utf-8'));

// stopId → Stop 빠른 조회를 위한 Map
const STOPS_MAP = new Map<string, Stop>(ALL_STOPS.map(s => [s.id, s]));

const SERVICE_KEY = process.env.BUS_SERVICE_KEY!;
const BASE_URL = process.env.BUS_API_BASE!;

/** Haversine 거리 계산 (m) */
function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── 캐시 상태 확인 (디버그) ───────────────────────────────────────────
router.get('/cache/stats', (_req: Request, res: Response) => {
  res.json({ success: true, data: getCacheStats() });
});

// ── 정류장 이름 검색 ──────────────────────────────────────────────
router.get('/search', (req: Request, res: Response) => {
  const { name } = req.query as Record<string, string>;
  if (!name?.trim()) { res.status(400).json({ error: 'name 파라미터 필수' }); return; }

  const keyword = name.trim();
  const results = ALL_STOPS.filter(s => s.name.includes(keyword)).slice(0, 30);
  res.json({ success: true, data: results, total: results.length });
});

// ── GPS 기반 근처 정류장 ──────────────────────────────────────────
router.get('/nearby', (req: Request, res: Response) => {
  const { lat, lng, radius } = req.query as Record<string, string>;
  if (!lat || !lng) { res.status(400).json({ error: 'lat, lng 파라미터 필수' }); return; }

  const userLat = parseFloat(lat);
  const userLng = parseFloat(lng);
  const r = parseFloat(radius ?? '500');

  const results = ALL_STOPS
    .map(s => ({ ...s, distance: Math.round(distanceMeters(userLat, userLng, s.lat, s.lng)) }))
    .filter(s => s.distance <= r)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 20);

  res.json({ success: true, data: results, total: results.length });
});

// ── 정류장 경유 노선 목록 ─────────────────────────────────────────
router.get('/:stopId/routes', async (req: Request, res: Response) => {
  const stopId = req.params.stopId as string;
  const stop = STOPS_MAP.get(stopId);

  if (!stop) { res.status(404).json({ error: '정류장을 찾을 수 없습니다.' }); return; }

  // ── 1순위: routeCache (busRouteInfo API 사전 캐시) ────────────────
  if (isCacheReady()) {
    const nodeIds = [stop.nationalCode, stop.settlementCode, stop.id].filter(Boolean);
    const routes = getRoutesByNodeIds(nodeIds);
    if (routes.length > 0) {
      res.json({ success: true, stopName: stop.name, source: 'cache', data: routes });
      return;
    }
  }

  // ── 2순위: busposinfo getSttnAcctoRouteList 직접 호출 ────────────
  const tryNodeIds = [stop.nationalCode, stop.settlementCode, stop.id].filter(Boolean);

  for (const nodeId of tryNodeIds) {
    try {
      const params = new URLSearchParams({
        serviceKey: SERVICE_KEY,
        resultType: 'json',
        nodeid: nodeId,
        numOfRows: '50',
      });
      const url = `${BASE_URL}/getSttnAcctoRouteList?${params}`;
      const { data } = await axios.get(url, { timeout: 6000 });

      const items = data?.response?.body?.items?.item;
      if (!items) continue;

      const routes = (Array.isArray(items) ? items : [items]).map((r: any) => ({
        routeId: r.routeid ?? '',
        routeNo: r.routeno ?? r.routeNo ?? '',
        routeType: r.routetp ?? '',
        startStop: r.startnodenm ?? '',
        endStop: r.endnodenm ?? '',
      }));

      if (routes.length > 0) {
        res.json({ success: true, stopName: stop.name, source: 'realtime', nodeIdUsed: nodeId, data: routes });
        return;
      }
    } catch (_) {
      // 다음 nodeId로 재시도
    }
  }

  // ── 3순위: 도착 예정 정보 폴백 (현재 운행 중인 버스만) ────────────
  try {
    const params = new URLSearchParams({
      serviceKey: SERVICE_KEY,
      resultType: 'json',
      nodeid: stop.nationalCode,
      numOfRows: '30',
    });
    const url = `${BASE_URL}/getSttnAcctoArvlPrearngeInfoList?${params}`;
    const { data } = await axios.get(url, { timeout: 6000 });
    const items = data?.response?.body?.items?.item;

    if (items) {
      const routes = (Array.isArray(items) ? items : [items]).map((r: any) => ({
        routeId: r.routeid ?? '',
        routeNo: r.routeno ?? '',
        routeType: '',
        startStop: '',
        endStop: '',
        arrivalMin: r.arrprevstationcnt ?? null,
      }));
      res.json({ success: true, stopName: stop.name, source: 'arrival', data: routes });
      return;
    }
  } catch (_) {}

  res.json({ success: true, stopName: stop.name, data: [], message: 'API에서 노선 정보를 가져올 수 없습니다.' });
});

export default router;
