/**
 * 대전 버스 노선 캐시
 *
 * 서버 시작 시 busRouteInfo API 에서 전체 노선 정보와 노선별 정류장 목록을 한 번 로드해
 * 메모리에 캐싱합니다. 이를 통해 정류장 ID → 경유 노선 목록을 즉시 반환할 수 있습니다.
 *
 * API 출처: https://apis.data.go.kr/6300000/busRouteInfo
 *   - getRouteInfoAll   : 전체 노선 기본 정보 (routeid, routeno, routetp, startnodenm, endnodenm)
 *   - getStaionByRouteAll: 전체 노선별 정류장 목록 (routeid, nodeid, nodenm, nodeord)
 */

import axios from 'axios';

const SERVICE_KEY = process.env.BUS_SERVICE_KEY!;
const ROUTE_API_BASE = process.env.BUS_ROUTE_API_BASE ?? 'https://apis.data.go.kr/6300000/busRouteInfo';

export interface RouteInfo {
  routeId: string;
  routeNo: string;
  routeType: string;
  startStop: string;
  endStop: string;
}

// routeId → RouteInfo
let routeMap = new Map<string, RouteInfo>();

// nodeId → RouteInfo[]  (정류장별 경유 노선 목록)
let stopRoutesMap = new Map<string, RouteInfo[]>();

let initialized = false;
let initPromise: Promise<void> | null = null;

// ── 페이지네이션 헬퍼 ────────────────────────────────────────────────
async function fetchAllPages<T>(endpoint: string, extraParams: Record<string, string> = {}): Promise<T[]> {
  const results: T[] = [];
  let page = 1;
  const numOfRows = 1000;

  while (true) {
    const params = new URLSearchParams({
      serviceKey: SERVICE_KEY,
      resultType: 'json',
      numOfRows: String(numOfRows),
      pageNo: String(page),
      ...extraParams,
    });
    const url = `${ROUTE_API_BASE}/${endpoint}?${params}`;

    try {
      const { data } = await axios.get(url, { timeout: 15000 });
      const items = data?.response?.body?.items?.item;
      if (!items) break;

      const arr: T[] = Array.isArray(items) ? items : [items];
      results.push(...arr);

      const totalCount: number = data?.response?.body?.totalCount ?? 0;
      if (results.length >= totalCount || arr.length < numOfRows) break;
      page++;
    } catch (err) {
      console.error(`[routeCache] ${endpoint} page ${page} 오류:`, err);
      break;
    }
  }

  return results;
}

// ── 캐시 초기화 ──────────────────────────────────────────────────────
async function _init(): Promise<void> {
  console.log('[routeCache] 노선 캐시 초기화 시작…');

  try {
    // 1) 전체 노선 기본 정보
    const routeItems = await fetchAllPages<any>('getRouteInfoAll');
    routeMap = new Map<string, RouteInfo>();

    for (const r of routeItems) {
      const info: RouteInfo = {
        routeId: r.routeid ?? '',
        routeNo: r.routeno ?? '',
        routeType: r.routetp ?? '',
        startStop: r.startnodenm ?? '',
        endStop: r.endnodenm ?? '',
      };
      if (info.routeId) routeMap.set(info.routeId, info);
    }

    console.log(`[routeCache] 노선 ${routeMap.size}개 로드 완료`);

    // 2) 전체 노선별 정류장 목록
    const stationItems = await fetchAllPages<any>('getStaionByRouteAll');
    stopRoutesMap = new Map<string, RouteInfo[]>();

    for (const s of stationItems) {
      const nodeId: string = s.nodeid ?? '';
      const routeId: string = s.routeid ?? '';
      if (!nodeId || !routeId) continue;

      const routeInfo = routeMap.get(routeId);
      if (!routeInfo) continue;

      if (!stopRoutesMap.has(nodeId)) {
        stopRoutesMap.set(nodeId, []);
      }
      // 중복 방지
      const list = stopRoutesMap.get(nodeId)!;
      if (!list.some(r => r.routeId === routeId)) {
        list.push(routeInfo);
      }
    }

    console.log(`[routeCache] 정류장-노선 매핑 ${stopRoutesMap.size}개 정류장 완료`);
    initialized = true;
  } catch (err) {
    console.error('[routeCache] 초기화 오류:', err);
    // 실패해도 서버는 계속 동작 — 개별 API 폴백으로 대응
    initialized = true;
  }
}

/** 서버 시작 시 1회 호출 */
export function initRouteCache(): Promise<void> {
  if (!initPromise) {
    initPromise = _init();
  }
  return initPromise;
}

/** 초기화 완료 여부 */
export function isCacheReady(): boolean {
  return initialized;
}

/**
 * nodeId(정류장 코드)로 경유 노선 목록 반환
 * @param nodeIds 시도할 nodeId 목록 (국토부코드, 정산코드, 로컬ID 순)
 */
export function getRoutesByNodeIds(nodeIds: string[]): RouteInfo[] {
  for (const id of nodeIds) {
    const routes = stopRoutesMap.get(id);
    if (routes && routes.length > 0) return routes;
  }
  return [];
}

/** 디버그: 캐시 통계 */
export function getCacheStats() {
  return {
    routes: routeMap.size,
    stops: stopRoutesMap.size,
    initialized,
  };
}
