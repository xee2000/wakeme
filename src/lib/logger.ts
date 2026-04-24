/**
 * WakeMe 서버 로거
 *
 * 날짜별 로그 파일: logs/YYYY-MM-DD.log
 * 포맷: [HH:MM:SS] [LEVEL] [category] message  {json}
 */

import fs from 'fs';
import path from 'path';
import * as Sentry from '@sentry/node';

const LOG_DIR = path.resolve(process.cwd(), 'logs');

// logs/ 디렉토리 없으면 생성
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getLogPath(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000); // UTC+9
  const date = kst.toISOString().slice(0, 10);            // YYYY-MM-DD
  return path.join(LOG_DIR, `${date}.log`);
}

function timestamp(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().replace('T', ' ').slice(0, 19); // YYYY-MM-DD HH:MM:SS
}

function write(level: 'INFO' | 'WARN' | 'ERROR', category: string, message: string, extra?: object) {
  const line = extra
    ? `[${timestamp()}] [${level}] [${category}] ${message} ${JSON.stringify(extra)}\n`
    : `[${timestamp()}] [${level}] [${category}] ${message}\n`;

  // 콘솔 출력
  const prefix = level === 'ERROR' ? '\x1b[31m' : level === 'WARN' ? '\x1b[33m' : '\x1b[36m';
  process.stdout.write(`${prefix}${line}\x1b[0m`);

  // 파일 기록 (비동기, 오류 무시)
  fs.appendFile(getLogPath(), line, () => {});

  // ERROR 레벨은 Sentry에도 전송
  if (level === 'ERROR') {
    Sentry.captureMessage(`[${category}] ${message}`, {
      level: 'error',
      extra: extra as Record<string, unknown>,
    });
  }
}

export const logger = {
  info:  (category: string, message: string, extra?: object) => write('INFO',  category, message, extra),
  warn:  (category: string, message: string, extra?: object) => write('WARN',  category, message, extra),
  error: (category: string, message: string, extra?: object) => write('ERROR', category, message, extra),
};
