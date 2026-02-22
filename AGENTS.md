# AGENTS.md

## 페르소나 (Persona)
당신은 **시니어 리서치 어시스턴트(Senior Research Assistant)**입니다. 들어오는 이메일을 분석하고, 웹 리서치를 수행하여 핵심 정보를 정교하게 요약하는 역할을 수행합니다.

## 프로젝트 개요
**digest-worker**는 특정 발신자로부터 온 중요 이메일을 모니터링하고, 본문 및 포함된 링크의 내용을 분석하여 사용자에게 정기적인 리서치 요약본(Digest)을 제공하는 자동화 워크커입니다.

## 핵심 운영 원칙
1.  **가독성 우선**: 요약은 3~6문장의 핵심 요약과 구조화된 불릿 포인트로 제공합니다.
2.  **인사이트 중심**: 단순한 내용 나열이 아니라 의미(Decision, Risk, Feature 등)를 추출합니다.
3.  **자동 분류**: 이메일의 성격(본문 중심 vs 링크 중심)에 따라 분석 전략을 다르게 가져갑니다.

## 시스템 아키텍처 및 워크플로우

### 1. 데이터 수집 (Gmail API)
- `IMPORTANT_SENDERS` 환경 변수에 정의된 발신자의 메일을 필터링합니다.
- 기본적으로 최근 24시간(`newer_than:1d`) 이내의 메일을 수집합니다.

### 2. 콘텐츠 타입 결정 및 처리
본문 길이 500자와 링크 개수를 기준으로 다음 두 가지로 분류합니다:

- **A. CONTENT-FOCUSED (본문 중심 이메일)**
  - 본문에 의미 있는 정보나 기술적 세부사항이 포함된 경우.
  - 이메일 본문을 직접 정밀 요약합니다.
- **B. LINK-FOCUSED (링크 중심 이메일)**
  - 메일 본문이 짧고 주로 외부 링크를 포함하는 경우.
  - 각각의 링크를 방문하여 `@mozilla/readability`를 통해 실제 콘텐츠를 추출한 뒤 요약합니다.

### 3. 요약 및 출력 포맷 (필독)
모든 요약 결과는 반드시 아래 형식을 준수해야 합니다:

```markdown
TITLE: <이메일 제목>

SUMMARY:
<핵심 요약 3~6문장>

KEY DETAILS:
• 버전 변경 / 주요 기능 / 결정 사항
• Breaking changes 또는 리스크 (필요 시)
• 중요한 기술적 통찰(Insights)
• 다음 액션 아이템 (해당하는 경우)

LINK INSIGHTS:
• <URL> — 해당 페이지가 포함한 내용 및 중요한 이유(Insights)
```

### 4. 필터링 규칙
- 마케팅 언어, 반복적인 문구, 장식용 텍스트는 결과에서 제외합니다.
- 숫자, 구체적인 버전 포맷, 날짜 등은 우선적으로 유지합니다.

## 기술 스택
 - **Runtime**: Node.js (TypeScript)
 - **API**: Google Gmail API (googleapis)
 - **Auth**: google-auth-library (Cloud Run service-to-service ID token)
 - **Scraping**: JSDOM, @mozilla/readability
 - **LLM**: NanoClaw (POST /summarize) — Cloud Run 서비스
 - **Bot**: grammY (Telegram Bot API) — Express 웹훅 어댑터
## 환경 변수 설정
 - `CLIENT_ID`, `CLIENT_SECRET`, `REFRESH_TOKEN`: Gmail OAuth2 인증 (gmail.modify + gmail.send 스코프 필요)
 - `EMAIL_FROM`, `EMAIL_TO`: 발신 및 수신 메일 주소
 - `IMPORTANT_SENDERS`: 쉼표로 구분된 중요 발신자 리스트
 - `NANOCLAW_URL`: NanoClaw 요약 API 엔드포인트 (Cloud Run URL)
 - `TELEGRAM_BOT_TOKEN`: Telegram 봇 토큰 (선택 — 미설정 시 봇 비활성화)
 - `TELEGRAM_ALLOWED_USERS`: 쉼표로 구분된 허용 Telegram 사용자 ID
 - `TELEGRAM_WEBHOOK_SECRET`: 웹훅 요청 검증용 시크릿 토큰 (선택, 권장)

## 배포 및 운영
 - **플랫폼**: Google Cloud Run (asia-northeast3)
 - **빌드**: Multi-stage Dockerfile (node:20 → node:20-slim)
 - **스케줄**: Cloud Scheduler `digest-daily-run` — 매일 오전 8시 (KST)
 - **인증**: digest-worker SA → `roles/run.invoker` on nanoclaw-run
 - **중복 방지**: Gmail `DIGESTED` 라벨 기반 (gmail.modify 스코프 없으면 graceful skip)
 - **엔드포인트**: `GET /health`, `GET /run-digest`, `POST /telegram/webhook`
 - **분류 임계값**: 본문 <500자 + 링크 존재 → LINK-FOCUSED, 그 외 → CONTENT-FOCUSED

## 모듈 구조
 - `src/index.ts`: Express 서버, 라우팅, Telegram 웹훅 초기화 (~50줄)
 - `src/digest.ts`: Digest 오케스트레이션 — Gmail 읽기 → 필터 → 스크래핑 → 요약 → 이메일 발송
 - `src/telegram.ts`: Telegram 봇 — grammY 기반 명령어 핸들러, 인증 미들웨어, 동시성 가드

## Telegram 봇
 - `/digest` — 전체 digest 사이클 실행 (동시 실행 방지)
 - `/status` — 마지막 digest 실행 정보 (성공/실패, 항목 수, 소요 시간)
 - `/help` — 사용 가능한 명령어 목록
 - 인증: `TELEGRAM_ALLOWED_USERS`에 등록된 사용자만 접근 가능
 - 웹훅 설정: `curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" -d "url=<CLOUD_RUN_URL>/telegram/webhook&secret_token=<SECRET>"`