/**
 * FCM 푸시 알림 라우터 (Firebase Admin SDK)
 *
 * POST /api/notify/token     FCM 토큰 등록/갱신
 * POST /api/notify/prepare   하차 준비 알림 (300m)
 * POST /api/notify/exit      하차 알림 (150m)
 */

import { Router, Response } from 'express';
import admin from 'firebase-admin';
import { getSupabaseAdmin } from '../lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();

// ── Firebase Admin 지연 초기화 ────────────────────────────────────
function getFirebaseApp(): admin.app.App {
  if (admin.apps.length) return admin.apps[0]!;

  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
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

async function sendFcm(token: string, title: string, body: string): Promise<void> {
  const app = getFirebaseApp();
  await admin.messaging(app).send({
    token,
    notification: { title, body },
    android: {
      priority: 'high',
      notification: { sound: 'default', channelId: 'wakeme-alert' },
    },
    apns: { payload: { aps: { sound: 'default', badge: 1 } } },
  });
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

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

/** 하차 준비 알림 (300m 이내) */
router.post('/prepare', authMiddleware, async (req: AuthRequest, res: Response) => {
  const { stopName } = req.body as { stopName: string };
  const token = await getFcmToken(req.userId!);
  if (!token) { res.status(404).json({ error: 'FCM 토큰 없음' }); return; }

  await sendFcm(token, '🔔 곧 하차할 정류장입니다', `다음 정류장 "${stopName}" 에서 준비하세요!`);
  res.json({ success: true });
});

/** 하차 알림 (150m 이내) */
router.post('/exit', authMiddleware, async (req: AuthRequest, res: Response) => {
  const { stopName } = req.body as { stopName: string };
  const token = await getFcmToken(req.userId!);
  if (!token) { res.status(404).json({ error: 'FCM 토큰 없음' }); return; }

  await sendFcm(token, '🚨 지금 내리세요!', `"${stopName}" 정류장입니다. 지금 내리세요!`);
  res.json({ success: true });
});

export default router;
