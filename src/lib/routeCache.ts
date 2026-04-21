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
import { XMLParser } from 'fast-xml-parser';

const SERVICE_KEY = process.env.BUS_SERVICE_KEY!;
const ROUTE_API_BASE = process.env.BUS_ROUTE_API_BASE ?? 'https://apis.data.go.kr/6300000/busRouteInfo';

const xmlParser = new XMLParser({ ignoreAttributes: false });

export interface RouteInfo {
  routeId: string;
  routeNo: string;
  routeType: string;
  startStop: string;
  endStop: string;
}

export interface StopInfo {
  nodeId: string;
  nodeName: string;
  gpslati: number;
  gpslong: number;
  seq: number;
}

// routeId → RouteInfo
let routeMap = new Map<string, RouteInfo>();

// nodeId → RouteInfo[]  (정류장별 경유 노선 목록)
let stopRoutesMap = new Map<string, RouteInfo[]>();

// routeNo → routeId[]  (노선번호 → routeId, 동명 노선 대비 복수)
let routeNoToIdMap = new Map<string, string[]>();

// routeId → StopInfo[]  (노선별 정류장 목록, 순서 정렬)
let routeStopsMap = new Map<string, StopInfo[]>();

let initialized = false;
let initPromise: Promise<void> | null = null;

// ── 페이지네이션 헬퍼 ────────────────────────────────────────────────
async function fetchAllPages<T>(endpoint: string, extraParams: Record<string, string> = {}): Promise<T[]> {
  const results: T[] = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      serviceKey: SERVICE_KEY,
      reqPage: String(page),
      ...extraParams,
    });
    const url = `${ROUTE_API_BASE}/${endpoint}?${params}`;

    try {
      const { data } = await axios.get(url, { timeout: 30000, responseType: 'text' });
      const parsed = xmlParser.parse(data);
      const header = parsed?.ServiceResult?.msgHeader;
      const items = parsed?.ServiceResult?.msgBody?.itemList;
      if (!items) break;

      const arr: T[] = Array.isArray(items) ? items : [items];
      results.push(...arr);

      const totalPages: number = header?.itemPageCnt ?? 1;
      console.log(`[routeCache] ${endpoint} ${page}/${totalPages} 페이지 완료 (누적 ${results.length}건)`);
      if (page >= totalPages) break;
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
    const ROUTE_TYPE_LABEL: Record<string, string> = {
      '1': '급행버스', '2': '간선버스', '3': '지선버스', '4': '마을버스', '5': '외곽버스',
    };

    // 1) 전체 노선 기본 정보 (start/end는 nodeId 임시 저장)
    const routeItems = await fetchAllPages<any>('getRouteInfoAll');
    routeMap = new Map<string, RouteInfo>();
    const startNodeMap = new Map<string, string>(); // routeId → startNodeId
    const endNodeMap = new Map<string, string>();   // routeId → endNodeId

    routeNoToIdMap = new Map<string, string[]>();

    for (const r of routeItems) {
      const routeId = String(r.ROUTE_CD ?? '');
      const routeNo = String(r.ROUTE_NO ?? '').trim();
      const tp = String(r.ROUTE_TP ?? '').trim();
      const info: RouteInfo = {
        routeId,
        routeNo,
        routeType: ROUTE_TYPE_LABEL[tp] ?? tp,
        startStop: '',
        endStop: '',
      };
      if (routeId) {
        routeMap.set(routeId, info);
        startNodeMap.set(routeId, String(r.START_NODE_ID ?? ''));
        endNodeMap.set(routeId, String(r.END_NODE_ID ?? ''));
        // 노선번호 → routeId 맵
        if (routeNo) {
          if (!routeNoToIdMap.has(routeNo)) routeNoToIdMap.set(routeNo, []);
          routeNoToIdMap.get(routeNo)!.push(routeId);
        }
      }
    }

    console.log(`[routeCache] 노선 ${routeMap.size}개 로드 완료`);

    // 2) 전체 노선별 정류장 목록 + nodeId→name 맵 구축
    const stationItems = await fetchAllPages<any>('getStaionByRouteAll');
    stopRoutesMap = new Map<string, RouteInfo[]>();
    routeStopsMap = new Map<string, StopInfo[]>();
    const nodeNameMap = new Map<string, string>(); // nodeId → stopName

    for (const s of stationItems) {
      const nodeId: string = String(s.BUS_NODE_ID ?? '');
      const routeId: string = String(s.ROUTE_CD ?? '');
      const stopName: string = String(s.BUSSTOP_NM ?? '');
      const seq: number = Number(s.BUSSTOP_SEQ ?? 0);
      const lat: number = parseFloat(s.GPS_LATI ?? '0');
      const lng: number = parseFloat(s.GPS_LONG ?? '0');

      if (nodeId && stopName) nodeNameMap.set(nodeId, stopName);
      if (!nodeId || !routeId) continue;

      const routeInfo = routeMap.get(routeId);
      if (!routeInfo) continue;

      // 정류장 → 노선 역방향 매핑
      if (!stopRoutesMap.has(nodeId)) stopRoutesMap.set(nodeId, []);
      const routeList = stopRoutesMap.get(nodeId)!;
      if (!routeList.some(r => r.routeId === routeId)) routeList.push(routeInfo);

      // 노선 → 정류장 순방향 매핑
      if (!routeStopsMap.has(routeId)) routeStopsMap.set(routeId, []);
      routeStopsMap.get(routeId)!.push({ nodeId, nodeName: stopName, gpslati: lat, gpslong: lng, seq });
    }

    // 노선별 정류장 순서 정렬
    for (const stops of routeStopsMap.values()) {
      stops.sort((a, b) => a.seq - b.seq);
    }

    // start/end 이름 채우기
    for (const [routeId, info] of routeMap) {
      info.startStop = nodeNameMap.get(startNodeMap.get(routeId) ?? '') ?? '';
      info.endStop   = nodeNameMap.get(endNodeMap.get(routeId) ?? '') ?? '';
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

/**
 * 노선번호(예: "107")로 해당 노선의 정류장 목록 반환
 * 동일 번호 노선이 여럿이면 모두 합쳐서 반환
 */
export function getStopsByRouteNo(routeNo: string): StopInfo[] {
  const routeIds = routeNoToIdMap.get(routeNo) ?? [];
  if (routeIds.length === 0) return [];
  if (routeIds.length === 1) return routeStopsMap.get(routeIds[0]) ?? [];
  // 복수 노선: 첫 번째 노선 반환 (상행/하행 분리 시 클라이언트에서 선택)
  return routeStopsMap.get(routeIds[0]) ?? [];
}

/** 디버그: 캐시 통계 */
export function getCacheStats() {
  return {
    routes: routeMap.size,
    stops: stopRoutesMap.size,
    routeStops: routeStopsMap.size,
    initialized,
  };
}
