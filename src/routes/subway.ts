/**
 * 지하철 역 정보 API (Supabase 기반)
 *
 * GET /api/subway/stations                     전체 역 목록
 * GET /api/subway/stations?city=서울            도시 필터
 * GET /api/subway/stations?city=서울&line=2호선  도시 + 호선 필터
 */

import { Router, Request, Response } from 'express';
import { getSupabaseAdmin } from '../lib/supabase';

const router = Router();

// 도시명 → station_id prefix
const CITY_PREFIX: Record<string, string> = {
  '서울': 'SEO',
  '인천': 'ICN',
  '부산': 'BSN',
  '대구': 'DAG',
  '대전': 'DJM',
};

// 도시+호선 → 노선 색상
const LINE_COLORS: Record<string, string> = {
  '서울-1호선': '#0052A4',
  '서울-2호선': '#009246',
  '서울-3호선': '#EF7C1C',
  '서울-4호선': '#00A2D1',
  '서울-5호선': '#996CAC',
  '서울-6호선': '#CD7C2F',
  '서울-7호선': '#747F00',
  '서울-8호선': '#E6186C',
  '서울-9호선': '#BDB092',
  '인천-1호선': '#7CA8D5',
  '인천-2호선': '#F5A200',
  '인천-7호선': '#747F00',
  '부산-1호선': '#F05A28',
  '부산-2호선': '#3CB44A',
  '부산-3호선': '#8C5E3A',
  '부산-4호선': '#7EC8E3',
  '대구-1호선': '#F5A200',
  '대구-2호선': '#009246',
  '대구-3호선': '#C9A227',
  '대전-1호선': '#F5A200',
};

// prefix → 도시명
const PREFIX_CITY: Record<string, string> = Object.fromEntries(
  Object.entries(CITY_PREFIX).map(([city, prefix]) => [prefix, city]),
);

function getColor(city: string, line: string): string {
  return LINE_COLORS[`${city}-${line}`] ?? '#888888';
}

router.get('/stations', async (req: Request, res: Response) => {
  const { line, city } = req.query as Record<string, string>;
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from('subway_stations')
    .select('station_id, station_name, line')
    .order('station_id');

  if (city && CITY_PREFIX[city]) {
    query = (query as any).like('station_id', `${CITY_PREFIX[city]}%`);
  }
  if (line) {
    query = query.eq('line', line);
  }

  const { data, error } = await query;
  if (error) {
    res.status(500).json({ success: false, error: error.message });
    return;
  }

  const stations = (data ?? []).map((row, idx) => {
    const prefix = row.station_id.split('-')[0];
    const cityName = PREFIX_CITY[prefix] ?? '';
    const parts = row.station_id.split('-');
    const seq = parts.length >= 3 ? parseInt(parts[2], 10) : idx + 1;

    return {
      stationId: row.station_id,
      line: row.line,
      seq,
      name: row.station_name.replace(/\s*[\(\（].*?[\)\）]/g, '').trim(),
      fullName: row.station_name,
      color: getColor(cityName, row.line),
    };
  });

  res.json({ success: true, data: stations });
});

export default router;
