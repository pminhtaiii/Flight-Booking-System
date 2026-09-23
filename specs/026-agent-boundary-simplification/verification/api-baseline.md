# NestJS API Baseline Verification (Task T001)

- **Timestamp**: 2026-09-23T15:00:00+07:00
- **Commit SHA**: `8c7ef172b027e90a3715c77f35783ed59f88751a`

## Baseline Execution Results

### 1. NestJS Unit Test Suite (Targeted)
- **Command**:
  ```powershell
  Push-Location apps/api
  & '.\node_modules\.bin\jest.CMD' --runInBand src/chat/agent-chat.controller.spec.ts src/chat/agent-chat-access.service.spec.ts src/chat/chat-message-crypto.service.spec.ts src/agent-gateway/attested-flight-search/attested-flight-search.service.spec.ts src/agent-gateway/attested-flight-search/attested-flight-search.persistence.spec.ts
  Pop-Location
  ```
- **Exit Code**: `0`
- **Results Summary**:
  - Test Suites: 5 passed, 5 total
  - Tests: 66 passed, 66 total
  - Snapshots: 0 total
  - Execution Time: 268.024 s
  - Suites Breakdown:
    - `src/chat/agent-chat.controller.spec.ts` (PASS, 216.617 s)
    - `src/agent-gateway/attested-flight-search/attested-flight-search.persistence.spec.ts` (PASS, 6.818 s)
    - `src/chat/chat-message-crypto.service.spec.ts` (PASS)
    - `src/agent-gateway/attested-flight-search/attested-flight-search.service.spec.ts` (PASS, 8.788 s)
    - `src/chat/agent-chat-access.service.spec.ts` (PASS, 6.588 s)

### 2. NestJS E2E Test Suite (Targeted Boundary Suites)
- **Command**:
  ```powershell
  Push-Location apps/api
  & '.\node_modules\.bin\jest.CMD' --runInBand --config test/jest-e2e.json test/agent-chat-gateway.e2e-spec.ts test/agent-gateway.e2e-spec.ts test/chat.e2e-spec.ts test/chat-plaintext-cleanup.e2e-spec.ts test/chat-privacy-corpus.e2e-spec.ts test/negative-privacy-audit.e2e-spec.ts test/phase11d-cryptographic-audit.e2e-spec.ts test/phase11e-continuous-reliability.e2e-spec.ts test/privacy-and-telemetry-audit.e2e-spec.ts test/rollback-matrix.e2e-spec.ts
  Pop-Location
  ```
- **Exit Code**: `0`
- **Results Summary**:
  - Test Suites: 10 passed, 10 total
  - Tests: 117 passed, 117 total
  - Snapshots: 0 total
  - Execution Time: 551.715 s
  - Suites Breakdown:
    - `test/phase11d-cryptographic-audit.e2e-spec.ts` (PASS, 294.973 s)
    - `test/agent-gateway.e2e-spec.ts` (PASS, 85.452 s)
    - `test/chat-plaintext-cleanup.e2e-spec.ts` (PASS, 18.270 s)
    - `test/chat.e2e-spec.ts` (PASS, 23.283 s)
    - `test/agent-chat-gateway.e2e-spec.ts` (PASS, 14.083 s)
    - `test/privacy-and-telemetry-audit.e2e-spec.ts` (PASS, 14.993 s)
    - `test/rollback-matrix.e2e-spec.ts` (PASS, 44.895 s)
    - `test/chat-privacy-corpus.e2e-spec.ts` (PASS, 19.420 s)
    - `test/negative-privacy-audit.e2e-spec.ts` (PASS, 9.881 s)
    - `test/phase11e-continuous-reliability.e2e-spec.ts` (PASS, 11.310 s)

### 3. ESLint Verification
- **Command**:
  ```powershell
  pnpm exec eslint "apps/api/**/*.ts" "packages/shared/**/*.ts" --max-warnings 0
  ```
- **Exit Code**: `0`
- **Results Summary**: Passed with 0 errors and 0 warnings.

### 4. Shared Contracts & Types Unit Test Suite
- **Command**:
  ```powershell
  pnpm --filter @shared/types test
  ```
- **Exit Code**: `0`
- **Results Summary**:
  - Test Suites: 23 passed, 23 total
  - Tests: 110 passed, 0 failed, 0 skipped
  - Execution Time: 4.198 s

### 5. NestJS TypeScript Compilation Check
- **Command**:
  ```powershell
  pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
  ```
- **Exit Code**: `0`
- **Results Summary**: Zero type errors across all API backend sources.

### 6. NestJS Production Build
- **Command**:
  ```powershell
  pnpm --filter @api/backend build
  ```
- **Exit Code**: `0`
- **Results Summary**:
  - Shared types built successfully
  - Prisma client generated successfully (v5.22.0)
  - NestJS API compilation and packaging succeeded cleanly

### 7. Scope & Dependency Diff Guard (Task T005)
- **Command**:
  ```powershell
  git diff -- apps/api/prisma pnpm-lock.yaml apps/api/package.json apps/agent/pyproject.toml
  ```
- **Execution Timestamp**: `2026-09-23T15:04:36+07:00`
- **Commit SHA Anchor**: `8c7ef172b027e90a3715c77f35783ed59f88751a`
- **Exit Code**: `0`
- **Output**: Clean (0 lines changed, empty stdout/stderr)
- **Protected File Hash Manifest (SHA-256 Baseline)**:
  | File | SHA-256 Hash |
  |---|---|
  | `apps/api/prisma/schema.prisma` | `5B318AC83E798EF1EBFB9942068280EA400752D70C8EA0B41EDEDEE2D7C7C4E8` |
  | `pnpm-lock.yaml` | `C2FDDF0F65CAA381AE382CE79DFC227309646F3D1A35A9C56EE44912231B8807` |
  | `apps/api/package.json` | `F2988B020A4971F1A14530E33BC4346C2BE4FB03138A7A749DBB0DFFBA8BF022` |
  | `apps/agent/pyproject.toml` | `258D2E2FAFAF8FC1D714998399C9F6F2E755A84EE356B5A9F02FE1D1DE34B806` |

