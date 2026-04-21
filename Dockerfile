# ── 1단계: 빌드 ──────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# 의존성 설치
COPY package*.json ./
RUN npm ci

# 소스 복사 후 TypeScript 빌드
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# data 폴더를 dist 로 복사 (xcopy 대신 cp 사용)
RUN cp -r src/data dist/data

# ── 2단계: 실행 ──────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# 프로덕션 의존성만 설치
COPY package*.json ./
RUN npm ci --omit=dev

# 빌드 결과물 복사
COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/index.js"]
