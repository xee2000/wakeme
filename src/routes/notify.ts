/**
 * FCM 푸시 알림 라우터 (Firebase Admin SDK)
 *
 * POST /api/notify/token     FCM 토큰 등록/갱신
 * POST /api/notify/start     경로 모니터링 시작 로그
 * POST /api/notify/prepare   하차 준비 알림 (300m)
 * POST /api/notify/exit      하차 알림 (150m)
 */

import { Router, Request, Response } from 'express';
import admin from 'firebase-admin';
import { getSupabaseAdmin } from '../lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { AuthRequest } from '../types';
import { logger } from '../lib/logger';

const router = Router();

// ── Firebase Admin 지연 초기화 ────────────────────────────────────
function getFirebaseApp(): admin.app.App {
  if (admin.apps.length) return admin.apps[0]!;
  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

// ── 유틸 ─────────────────────────────────────────────────────────
async function getFcmToken(userId: string): Promise<string | null> {
  const { data } = await getSupabaseAdmin()
    .from('users')
    .select('fcm_token')
    .eq('id', userId)
    .single();
  return data?.fcm_token ?? null;
}

async function sendFcm(
  userId: string,
  token: string,
  title: string,
  body: string,
  tag: string,
): Promise<void> {
  const app = getFirebaseApp();
  const messageId = await admin.messaging(app).send({
    token,
    notification: { title, body },
    android: {
      priority: 'high',
      notification: { sound: 'default', channelId: 'wakeme-alert' },
    },
    apns: { payload: { aps: { sound: 'default', badge: 1 } } },
  });
  logger.info('FCM', `[${tag}] 전송 성공`, { userId, title, body, messageId });
}

// ── 출발까지 남은 시간 계산 ───────────────────────────────────────
function minutesUntilDepart(departTime: string): number {
  const [h, m] = departTime.split(':').map(Number);
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // KST
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const departMin = h * 60 + m;
  let diff = departMin - nowMin;
  if (diff < -120) diff += 1440; // 자정 넘어가는 경우
  return diff;
}

// ── 라우트 ────────────────────────────────────────────────────────

/** FCM 토큰 등록/갱신 */
router.post('/token', authMiddleware, async (req: AuthRequest, res: Response) => {
  const { fcmToken } = req.body as { fcmToken: string };
  if (!fcmToken) { res.status(400).json({ error: 'fcmToken 필수' }); return; }

  const { error } = await getSupabaseAdmin()
    .from('users')
    .update({ fcm_token: fcmToken })
    .eq('id', req.userId!);

  if (error) {
    logger.error('FCM', 'FCM 토큰 저장 실패', { userId: req.userId, error: error.message });
    res.status(500).json({ error: error.message });
    return;
  }
  logger.info('FCM', 'FCM 토큰 등록/갱신', { userId: req.userId });
  res.json({ success: true });
});

/**
 * GPS 폴링 위치 로그 (15초마다, 인증 불필요)
 * body: { userId, lat, lng, accuracy, waypoints: [{name, type, distanceM, inWindow, notified}] }
 */
router.post('/gps-poll', async (req: Request, res: Response) => {
  const { userId, lat, lng, accuracy, waypoints } = req.body as {
    userId:    string;
    lat:       number;
    lng:       number;
    accuracy:  number;
    waypoints: Array<{
      name:      string;
      type:      string;
      distanceM: number;
      inWindow:  boolean;
      notified:  boolean;
    }>;
  };

  const wpSummary = (waypoints ?? [])
    .map(w => `${w.name}(${w.distanceM}m${w.notified ? ' ✅알림완료' : w.inWindow ? '' : ' ⏰시간창밖'})`)
    .join(' | ');

  logger.info('GPS_POLL', `📍 위치 폴링`, {
    userId,
    coords:   `${lat?.toFixed(5)}, ${lng?.toFixed(5)}`,
    accuracy: `${Math.round(accuracy ?? 0)}m`,
    waypoints: wpSummary,
  });

  res.json({ success: true });
});

/**
 * 앱 생존 확인 heartbeat (10분 워치독 주기, 인증 불필요)
 * body: { userId, routeId, departTime, gpsEnabled }
 */
router.post('/heartbeat', async (req: Request, res: Response) => {
  const { userId, routeId, departTime, gpsEnabled } = req.body as {
    userId:     string;
    routeId:    string;
    departTime: string;
    gpsEnabled: boolean;
  };

  logger.info('HEARTBEAT', '앱 생존 확인', {
    userId,
    routeId,
    departTime,
    gpsStatus: gpsEnabled ? '✅ GPS 켜짐' : '❌ GPS 꺼짐',
  });

  res.json({ success: true, serverTime: new Date().toISOString() });
});

/**
 * 경로 모니터링 시작 로그 (인증 불필요 — 로그 전용)
 * body: { userId, routeName, busNos, endStopName, departTime }
 */
router.post('/start', async (req: Request, res: Response) => {
  const { userId, routeName, busNos, endStopName, departTime } = req.body as {
    userId: string;
    routeName: string;
    busNos: string[];
    endStopName: string;
    departTime: string;
  };

  const remaining = departTime ? minutesUntilDepart(departTime) : null;

  logger.info('ROUTE', `모니터링 시작: "${routeName}"`, {
    userId,
    busNos,
    endStopName,
    departTime,
    minutesLeft: remaining,
    memo: remaining !== null
      ? (remaining >= 0 ? `출발까지 ${remaining}분 남음` : `출발 ${Math.abs(remaining)}분 경과`)
      : '출발시간 없음',
  });

  res.json({ success: true, minutesLeft: remaining });
});

/** 하차 준비 알림 (300m 이내) */
router.post('/prepare', authMiddleware, async (req: AuthRequest, res: Response) => {
  const { stopName } = req.body as { stopName: string };
  logger.info('FCM', `하차 준비 알림 요청: "${stopName}"`, { userId: req.userId });

  const token = await getFcmToken(req.userId!);
  if (!token) {
    logger.warn('FCM', 'FCM 토큰 없음 — prepare 알림 불가', { userId: req.userId });
    res.status(404).json({ error: 'FCM 토큰 없음' });
    return;
  }

  try {
    await sendFcm(
      req.userId!,
      token,
      '🔔 곧 하차할 정류장입니다',
      `다음 정류장 "${stopName}"에서 준비하세요!`,
      'PREPARE',
    );
    res.json({ success: true });
  } catch (err: any) {
    logger.error('FCM', `prepare 알림 전송 실패: "${stopName}"`, {
      userId: req.userId,
      error: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

/** 하차 알림 (150m 이내) */
router.post('/exit', authMiddleware, async (req: AuthRequest, res: Response) => {
  const { stopName } = req.body as { stopName: string };
  logger.info('FCM', `하차 알림 요청: "${stopName}"`, { userId: req.userId });

  const token = await getFcmToken(req.userId!);
  if (!token) {
    logger.warn('FCM', 'FCM 토큰 없음 — exit 알림 불가', { userId: req.userId });
    res.status(404).json({ error: 'FCM 토큰 없음' });
    return;
  }

  try {
    await sendFcm(
      req.userId!,
      token,
      '🚨 지금 내리세요!',
      `"${stopName}" 정류장입니다. 지금 내리세요!`,
      'EXIT',
    );
    res.json({ success: true });
  } catch (err: any) {
    logger.error('FCM', `exit 알림 전송 실패: "${stopName}"`, {
      userId: req.userId,
      error: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

export default router;
