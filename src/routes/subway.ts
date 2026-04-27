/**
 * 지하철 역 정보 API
 *
 * GET /api/subway/stations           전체 역 목록
 * GET /api/subway/stations?line=1호선 호선 필터
 */

import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';

const router = Router();

interface SubwayStation {
  stationId: string;
  line: string;
  seq: number;
  name: string;
  fullName: string;
  color: string;
}

const stationsPath = path.join(__dirname, '../data/subway_stations.json');
const ALL_STATIONS: SubwayStation[] = JSON.parse(fs.readFileSync(stationsPath, 'utf-8'));

router.get('/stations', (req: Request, res: Response) => {
  const { line } = req.query as Record<string, string>;
  const data = line
    ? ALL_STATIONS.filter(s => s.line === line)
    : ALL_STATIONS;
  res.json({ success: true, data });
});

export default router;
