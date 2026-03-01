# digest-worker 재구축 분석서 (Human + Agent Spec)

작성 기준 시점: 2026-03-02 (KST)  
분석 대상 HEAD: `8ef54c8` (`main`)

---

## 0) Executive Summary
이 저장소는 **중요 발신자 메일을 수집 → 본문/링크 콘텐츠를 정제 → 외부 요약 서비스(NanoClaw)로 요약 → Digest 메일 발송**하는 Cloud Run용 TypeScript 워커입니다.  
초기 버전은 `src/index.ts` 단일 파일 구조였고, 이후 Telegram 봇 제어/상태 조회, 배포 스크립트, 시간 범위 파라미터, 링크 추출 정교화가 추가되며 현재 구조(`index + digest + telegram`)로 안정화되었습니다.  
현재 Markdown 문서는 실질적으로 `AGENTS.md` 하나이며, 운영 정책/요약 포맷/배포 컨텍스트가 이 파일에 집중되어 있습니다.

---

## 1) Human Readable 분석

## 1.1 현재 파일 구조 (핵심 파일 중심)
아래는 재구축에 필요한 핵심 구성입니다.

```text
.
├─ AGENTS.md                  # 운영 원칙/요약 포맷/아키텍처 문서
├─ package.json               # 런타임/의존성 정의
├─ tsconfig.json              # TS 컴파일 설정
├─ Dockerfile                 # multi-stage 빌드 (node:20 -> node:20-slim)
├─ deploy.sh                  # Cloud Run 배포 스크립트
├─ setup-secrets.sh           # Secret Manager 초기 세팅 스크립트
├─ .env.example               # 환경변수 템플릿
├─ .env.yaml                  # 비민감 env 배포 파일 (--env-vars-file)
├─ src/
│  ├─ index.ts                # Express 서버 + 라우팅 + Telegram webhook 장착
│  ├─ digest.ts               # 핵심 오케스트레이션 (Gmail/스크래핑/요약/발송)
│  └─ telegram.ts             # grammY 봇 (/digest, /status, /help)
└─ dist/                      # 빌드 산출물 (컴파일 결과)
```

참고:
- `node_modules/`, `dist/`는 소스 재구축 대상이 아닌 설치/빌드 산출물입니다.
- `.env`는 로컬 개발 편의 파일로 보이며, 운영 기준은 `.env.yaml + Secret Manager` 조합입니다.

## 1.2 Markdown 파일 분석
현재 저장소 내 `.md` 파일은 `AGENTS.md` 1개입니다.

### AGENTS.md가 규정하는 핵심 규칙
- 페르소나: "Senior Research Assistant"
- 이메일 처리 분기:
  - `CONTENT-FOCUSED`: 본문 중심 요약
  - `LINK-FOCUSED`: 링크 방문 후 콘텐츠 추출/요약
- 분류 임계값: **본문 < 500자 + 링크 존재 → LINK-FOCUSED**, 그 외 CONTENT
- 요약 출력 포맷 강제:
  - `TITLE`, `SUMMARY`, `KEY DETAILS`, `LINK INSIGHTS`
- 배포 컨텍스트:
  - Cloud Run (asia-northeast3)
  - Cloud Scheduler daily 8AM KST
  - DIGESTED 라벨 기반 중복 방지

주의:
- 현재 코드(`src/digest.ts`)는 분류 함수가 제거되어 **"링크가 있으면 항상 스크래핑"** 전략으로 진화했습니다. 즉, AGENTS 문서의 "분류 임계값"과 구현 사이에 작은 드리프트가 있습니다.

## 1.3 현재 런타임 동작 흐름

### 진입점
- `GET /health` → 단순 헬스체크
- `GET /run-digest?range=1d` → digest 실행 (range 유효성 검사 포함)
- `POST /telegram/webhook` → Telegram 봇 명령 수신 (옵션)

### Digest 파이프라인 (`src/digest.ts`)
1. 필수 env 검증 (`requireEnv`)
2. Gmail OAuth2 클라이언트 생성
3. DIGESTED 라벨 조회/생성 시도
   - 실패해도 graceful skip (권한 없을 때 계속 동작)
4. Gmail 검색 쿼리 구성
   - `from:sender1 OR from:sender2 ...`
   - `newer_than:<range>`
   - 가능하면 `-label:DIGESTED`
5. 메시지 목록 조회 후 개별 메시지 상세 조회
6. 본문 추출 (text/plain 우선, snippet fallback)
7. 링크 추출
   - plain text URL regex
   - HTML `<a href>` 파싱 (JSDOM)
   - junk URL 필터링 (unsubscribe/track/pixel/이미지 등)
8. 링크가 있으면 링크 스크래핑 수행
   - 최대 5개 링크
   - timeout 10초
   - Readability로 article text 추출
9. NanoClaw `/summarize` 호출
   - Cloud Run 환경이면 ID Token auth 헤더 첨부
10. 발신자 기준 그룹핑 후 digest 본문 생성
11. Gmail API `messages.send`로 최종 digest 발송
12. 처리 메시지에 DIGESTED 라벨 추가 (가능 시)

### Telegram 흐름 (`src/telegram.ts`)
- 접근 제어: `TELEGRAM_ALLOWED_USERS` 화이트리스트
- `/digest [range]`: 동시 실행 방지(`isRunning`) + 실행 결과 회신
- `/status`: 마지막 실행 상태/처리건수/소요시간
- `/help`: 명령 안내

## 1.4 의존성/스택
`package.json` 기준:
- 런타임: Node.js + TypeScript
- 웹: `express`
- Gmail/API: `googleapis`, `google-auth-library`
- 스크래핑: `jsdom`, `@mozilla/readability`
- 봇: `grammy`

## 1.5 환경변수 체계
필수(코드 강제):
- `CLIENT_ID`
- `CLIENT_SECRET`
- `REFRESH_TOKEN`
- `EMAIL_FROM`
- `EMAIL_TO`
- `IMPORTANT_SENDERS`
- `NANOCLAW_URL`

선택(텔레그램 활성화 관련):
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USERS`
- `TELEGRAM_WEBHOOK_SECRET`

운영 권장 분리:
- 비민감: `.env.yaml` (`--env-vars-file`)
- 민감: Secret Manager (`--set-secrets`)

## 1.6 배포/운영 포인트
- Dockerfile: multi-stage로 `npm ci` + `npm run build` 후 slim image
- `deploy.sh`: Cloud Run 배포 자동화 + secret 주입 + 후속 체크 안내
- `setup-secrets.sh`: Secret Manager API enable, secret 생성, SA 권한 부여

운영 안전장치:
- dedup 라벨 실패 시에도 main flow 유지
- summarize 실패 시 snippet fallback
- Telegram 동시 실행 가드

## 1.7 커밋 타임라인 분석

1. `5287aab` (2026-02-19) Init
- 단일 `src/index.ts` 중심 구조
- Gmail 메일 조회 + digest 메일 발송 기본형

2. `6d41996` (2026-02-22) 대형 확장
- Cloud Run service-to-service ID token auth
- 링크 스크래핑(jsdom/readability) 도입
- CONTENT/LINK 분류(500자 임계값) 도입
- DIGESTED 라벨 dedup 도입
- `/health` 및 운영 로그 강화

3. `d92a465` (2026-02-23) 모듈화 + Telegram
- `index/digest/telegram` 3분할
- Telegram webhook + `/digest /status /help`
- optional bot 활성화 구조 완성

4. `c0e4af1` (2026-03-01) 운영 자동화
- `deploy.sh`, `setup-secrets.sh` 추가
- 배포/비밀관리 반복 작업 정리

5. `61556c5` (2026-03-01) 실행 범위 유연화
- API/Telegram에서 `range` 인자 지원
- `1d`, `3d`, `12h`, `30m` 형식 검증

6. `8ef54c8` (2026-03-01) 링크 품질 개선
- HTML anchor 기반 링크 추출 강화
- junk URL 필터링 추가
- digest 결과를 "발신자 그룹" 단위로 정렬
- 링크가 존재하면 스크래핑 우선으로 단순화

## 1.8 재구축 시 유의사항 (실무)
- AGENTS.md의 분류 규칙과 코드 구현 간 미세 불일치가 있으므로, 재구축 시 어느 정책을 정본으로 할지 먼저 결정해야 합니다.
- `.env.yaml`에 실제 값(이메일/URL/클라이언트ID)이 포함될 수 있으므로, 공개 저장소라면 값 비식별화 또는 Secret Manager 이관이 필요합니다.
- 테스트 코드가 없어 회귀 검증이 약합니다. 최소한 `validateTimeRange`, 링크 필터링, digest 포맷 생성은 단위 테스트를 추가하는 것이 안전합니다.

---

## 2) Agent 재생성용 spec.md / prompt

아래를 그대로 에이전트 입력으로 사용하면 현재 앱을 거의 동일 동작으로 재구축할 수 있습니다.

```md
# SPEC: Rebuild digest-worker (TypeScript, Cloud Run)

## Goal
중요 발신자 이메일을 정기 수집하고, 본문/링크 콘텐츠를 요약해 하나의 Digest 이메일로 발송하는 서비스 구현.

## Tech Constraints
- Runtime: Node.js 20
- Language: TypeScript (strict)
- HTTP server: Express
- Gmail: googleapis OAuth2
- Summarizer: External HTTP endpoint `${NANOCLAW_URL}/summarize`
- Optional bot: grammY Telegram webhook
- Scraping: jsdom + @mozilla/readability
- Deploy target: Google Cloud Run

## Required Project Structure
- package.json
- tsconfig.json
- Dockerfile
- src/index.ts
- src/digest.ts
- src/telegram.ts
- deploy.sh
- setup-secrets.sh
- .env.example

## Functional Requirements
1. Endpoints
- GET /health -> "ok"
- GET /run-digest?range=<timeRange>
  - default range: `1d`
  - validate range by regex `^(\d+)([dhm])$`
  - allowed:
    - days: 1..30
    - hours: 1..24
    - minutes: 1..60

2. Environment Validation
- Required env:
  - CLIENT_ID
  - CLIENT_SECRET
  - REFRESH_TOKEN
  - EMAIL_FROM
  - EMAIL_TO
  - IMPORTANT_SENDERS
  - NANOCLAW_URL
- Optional env:
  - TELEGRAM_BOT_TOKEN
  - TELEGRAM_ALLOWED_USERS
  - TELEGRAM_WEBHOOK_SECRET

3. Digest Core Flow
- Build Gmail query:
  - sender filter from IMPORTANT_SENDERS (split by comma or pipe)
  - newer_than:<range>
  - exclude DIGESTED label when label is available
- Fetch up to 10 messages.
- For each message:
  - extract Subject/From/snippet
  - extract text/plain body recursively from MIME parts, fallback snippet
  - extract URLs from both plain text and HTML anchor tags
  - deduplicate links
  - filter junk links:
    - localhost/127.0.0.1
    - oauth-style callback (`code` + `scope` query)
    - unsubscribe path
    - image file URLs (png/jpg/jpeg/gif/svg/ico/webp/bmp)
    - tracking-like host/path (click./track./open./pixel./beacon., /track|open|click|pixel/)
- If links exist:
  - scrape up to 5 links (10s timeout)
  - only process text/html responses
  - extract readable text with Readability
  - cap per-link extracted content before summarization
- Build summarize input and call `${NANOCLAW_URL}/summarize` with JSON:
  - title, source, content, links
- On Cloud Run (`K_SERVICE` exists), attach ID token auth header for NanoClaw audience origin.
- If summarize fails, fallback to snippet-based placeholder.

4. Digest Formatting & Delivery
- Group items by sender.
- For each sender block:
  - `══ From: <sender> ══`
  - item format:
    - `TITLE: <subject>`
    - summarized body text
- Send a single email via Gmail API `users.messages.send`.
- Subject format: `📬 Daily Research Digest (<itemCount>)`

5. Dedup
- Try create/find Gmail label `DIGESTED`.
- After successful processing of each message, add DIGESTED label.
- If label operations fail due to scope/permission, continue without dedup (graceful degradation).

6. Telegram Bot (optional)
- Enable only when TELEGRAM_BOT_TOKEN exists.
- Webhook endpoint: POST /telegram/webhook
- If TELEGRAM_WEBHOOK_SECRET exists, require secret token verification.
- Commands:
  - /help
  - /digest [range]
  - /status
- Authorization: allow only user IDs in TELEGRAM_ALLOWED_USERS.
- Concurrency guard: prevent overlapping /digest runs.
- Maintain in-memory last run status for /status.

## Non-Functional Requirements
- Log key steps with `[digest]` / `[telegram]` prefixes.
- Return structured result from digest execution:
  - success, itemCount, elapsed, message, digest
- Keep service operational when partial features fail (dedup/summarizer/link scrape).

## Scripts & Build
- package scripts:
  - `build`: `tsc -p tsconfig.json`
  - `start`: `node dist/index.js`
- Dockerfile:
  - build stage: npm ci + tsc
  - runtime stage: npm ci --omit=dev + dist only

## Deployment Scripts
- setup-secrets.sh:
  - enable Secret Manager API
  - create secrets if missing
  - grant `roles/secretmanager.secretAccessor` to Cloud Run service account
- deploy.sh:
  - gcloud run deploy using `--source=.`
  - inject non-sensitive vars from `.env.yaml`
  - inject secrets via `--set-secrets`
  - output service URL and post-deploy checks

## Acceptance Criteria
- `/health` returns 200 "ok".
- `/run-digest` with invalid range returns 400.
- `/run-digest` with valid range runs and returns success/failure message.
- With TELEGRAM_BOT_TOKEN unset, service still starts normally.
- With TELEGRAM enabled, unauthorized Telegram users are blocked.
- Duplicate mail suppression works when gmail.modify scope exists.
- Link-rich emails include scraped context in summarize payload.

## Optional Enhancements (Do not block MVP)
- Unit tests for `validateTimeRange`, URL filtering, link extraction.
- Persist `/status` state to storage (survive restart).
- Add retry/backoff for transient HTTP failures.
```

---

## 3) 재구축 우선순위 제안
1. `src/digest.ts` 기능 완성 (핵심 파이프라인)
2. `src/index.ts`에서 API route 연결
3. `src/telegram.ts` 옵션 기능 추가
4. Dockerfile + deploy scripts + Secret Manager 동선 마무리
5. 최소 단위 테스트 추가 후 배포

