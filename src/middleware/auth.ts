import { Response, NextFunction } from 'express';
import { getSupabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';

/**
 * Supabase JWT 검증 미들웨어
 * Authorization: Bearer <access_token> 헤더 필요
 */
export async function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: '인증 토큰이 없습니다.' });
    return;
  }

  const token = authHeader.split(' ')[1];
  const { data, error } = await getSupabaseAdmin().auth.getUser(token);

  if (error || !data.user) {
    res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
    return;
  }

  req.userId = data.user.id;
  next();
}
