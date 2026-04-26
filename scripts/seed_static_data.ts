/**
 * Supabase 정적 데이터 씨딩 스크립트
 *
 * 실행: npx ts-node scripts/seed_static_data.ts
 * 버스만: npx ts-node scripts/seed_static_data.ts bus
 * 지하철만: npx ts-node scripts/seed_static_data.ts subway
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const xmlParser = new XMLParser({ ignoreAttributes: false });

// ── 버스 정류장 씨딩 ─────────────────────────────────────────────────────────
async function seedBusStops() {
  console.log('\n[버스 정류장] stops.json 로드 중...');

  const raw = fs.readFileSync(
    path.join(__dirname, '../src/data/stops.json'),
    'utf-8'
  );
  const stops: Array<{
    id: string;
    name: string;
    lat: number;
    lng: number;
    district?: string;
    dong?: string;
  }> = JSON.parse(raw);

  console.log(`  총 ${stops.length}개 정류장 발견`);

  // 중복 node_id 제거 (첫 번째 항목 유지)
  const seen = new Set<string>();
  const unique = stops.filter(s => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
  if (unique.length < stops.length) {
    console.log(`  중복 제거: ${stops.length - unique.length}개 → ${unique.length}개`);
  }

  const rows = unique.map(s => ({
    node_id:   s.id,
    node_name: s.name,
    lat:       s.lat,
    lng:       s.lng,
    address:   [s.district, s.dong].filter(Boolean).join(' ') || null,
  }));

  // 500개씩 upsert (Supabase 단일 요청 한계 대비)
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('bus_stops')
      .upsert(chunk, { onConflict: 'node_id' });

    if (error) {
      console.error(`  오류 (${i}~${i + chunk.length}):`, error.message);
      process.exit(1);
    }
    console.log(`  ${Math.min(i + CHUNK, rows.length)} / ${rows.length} 완료`);
  }

  console.log('[버스 정류장] 씨딩 완료');
}

// ── 지하철 역 씨딩 ──────────────────────────────────────────────────────────
// API 스펙: stationNo 하나씩 조회 (101=판암 ~ 122=반석, 총 22역)
async function seedSubwayStations() {
  const SUBWAY_API_BASE = process.env.SUBWAY_API_BASE!;
  const serviceKey      = process.env.SUBWAY_SERVICE_KEY!;

  console.log('\n[지하철] 대전교통공사 API 호출 중 (22회)...');

  const rows: Array<{
    station_id: string;
    station_name: string;
    line: string;
    lat: number;
    lng: number;
    address: string | null;
  }> = [];

  // stationNo: 101(판암) ~ 122(반석)
  for (let stationNo = 101; stationNo <= 122; stationNo++) {
    const res = await axios.get(SUBWAY_API_BASE, {
      params: { ServiceKey: serviceKey, stationNo },
    });

    const parsed = xmlParser.parse(res.data);
    // 응답 구조: response.body.items.item 또는 response.body.item
    const body  = parsed?.response?.body;
    const item  = body?.items?.item ?? body?.item;

    if (!item) {
      console.warn(`  stationNo ${stationNo}: 데이터 없음`);
      continue;
    }

    rows.push({
      station_id:   String(item.stationNo),
      station_name: item.stationNmKor,
      line:         '1호선',
      lat:          Number(item.latitude),
      lng:          Number(item.longitude),
      address:      item.stationAddr ?? null,
    });

    console.log(`  ${stationNo} ${item.stationNmKor}  (${item.latitude}, ${item.longitude})`);
  }

  console.log(`\n  총 ${rows.length}개 역 수집 완료, Supabase에 저장 중...`);

  const { error } = await supabase
    .from('subway_stations')
    .upsert(rows, { onConflict: 'station_id' });

  if (error) {
    console.error('  오류:', error.message);
    process.exit(1);
  }

  console.log('[지하철] 씨딩 완료');
}

// ── 실행 ────────────────────────────────────────────────────────────────────
(async () => {
  const target = process.argv[2]; // 'bus' | 'subway' | undefined(전체)

  if (!target || target === 'bus')    await seedBusStops();
  if (!target || target === 'subway') await seedSubwayStations();

  console.log('\n완료');
  process.exit(0);
})();
