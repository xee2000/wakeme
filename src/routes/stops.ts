/**
 * 대전 버스 정류장 정적 데이터 API
 * 출처: 대전광역시_시내버스 기반정보_20250424.CSV (2,296개 정류장)
 *
 * GET /api/stops/search?name=중앙시장          이름 검색 (부분 일치)
 * GET /api/stops/nearby?lat=36.35&lng=127.38   GPS 기반 근처 정류장 (기본 반경 500m)
 */

import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';

const router = Router();

interface Stop {
  id: string;
  name: string;
  district: string;
  dong: string;
  lat: number;
  lng: number;
}

// 서버 시작 시 JSON 1회 로드
const stopsPath = path.join(__dirname, '../data/stops.json');
const ALL_STOPS: Stop[] = JSON.parse(fs.readFileSync(stopsPath, 'utf-8'));

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

/** 정류장 이름 검색 (부분 일치, 최대 30개) */
router.get('/search', (req: Request, res: Response) => {
  const { name } = req.query as Record<string, string>;
  if (!name?.trim()) {
    res.status(400).json({ error: 'name 파라미터 필수' });
    return;
  }

  const keyword = name.trim();
  const results = ALL_STOPS
    .filter(s => s.name.includes(keyword))
    .slice(0, 30);

  res.json({ success: true, data: results, total: results.length });
});

/** GPS 기반 근처 정류장 (반경 기본 500m, 최대 20개, 거리순) */
router.get('/nearby', (req: Request, res: Response) => {
  const { lat, lng, radius } = req.query as Record<string, string>;
  if (!lat || !lng) {
    res.status(400).json({ error: 'lat, lng 파라미터 필수' });
    return;
  }

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

export default router;
