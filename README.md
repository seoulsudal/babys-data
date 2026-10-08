# babys-data (BABYS 장소 데이터)

BABYS 앱이 내려받아 쓰는 **서울형 키즈카페 목록**(`docs/places.json`)을 매월 자동으로 갱신해 GitHub Pages로 게시하는 저장소입니다.
이 폴더(`deploy/places-data/`)는 BABYS 저장소 안의 **복사해 갈 원본**이고, 실제로는 별도의 공개 저장소로 만들어 씁니다.

## 구성

```
.github/workflows/update-places.yml   매월 4일(+수동) 수집 → 검증 → 바뀌었을 때만 커밋
tools/fetch_places.py                 장소 수집·검증 스크립트 (BABYS의 tools/fetch_places.py 와 같은 파일)
tools/check_vcninfo.py                예방접종 API 변경 점검 스크립트 (BABYS의 tools/check_vcninfo.py 와 같은 파일)
data/kdca-vcninfo-baseline.json     점검의 기준 스냅샷
.github/workflows/check-vcninfo.yml   매주 점검 + 변경 시 이슈 알림
docs/places.json                      게시되는 데이터 (Pages가 /docs 를 게시한다)
docs/.nojekyll                        Jekyll 처리를 끈다
```

- 인증키(Secrets)는 **필요 없습니다.** 서울 열린데이터광장의 공개 조회 주소를 씁니다.
- 수집이 실패하면(응답 구조 변경, 0건, 이전의 절반 미만) **파일을 덮어쓰지 않고** 작업이 실패합니다. 앱은 기존 데이터를 계속 씁니다.
- 앱도 받은 파일을 다시 검증하고(스키마·좌표·https·중복 등), 지금 것보다 오래됐거나 절반 미만이면 버립니다.

## 처음 한 번 하는 일 (사용자)

1. GitHub에서 **새 공개 저장소**를 만듭니다. 이름 예: `babys-data` (README·.gitignore·라이선스는 추가하지 않은 빈 저장소).
2. 이 폴더의 **내용**을 새 저장소 루트로 복사해 올립니다.
   ```bash
   # BABYS 저장소 루트에서
   cp -r deploy/places-data /tmp/babys-data && cd /tmp/babys-data
   git init -b main && git add -A && git commit -m "데이터 저장소 초기화"
   git remote add origin https://github.com/<내 아이디>/babys-data.git
   git push -u origin main
   ```
   (`.github` 폴더는 숨김이라 `cp -r`/`git add -A`에 포함되는지 확인하세요.)
   (`.gitattributes`가 줄바꿈을 LF로 고정합니다. 윈도우에서 CRLF로 바뀐 워크플로는 Actions에서 오류가 납니다.)
3. 저장소 **Settings → Pages**: Source = *Deploy from a branch*, Branch = `main`, 폴더 = `/docs` → Save.
4. 저장소 **Settings → Actions → General → Workflow permissions**: *Read and write permissions* 선택 → Save.
5. **Actions 탭 → Update places data → Run workflow**로 한 번 수동 실행해 초록색(성공)인지 확인합니다.
6. 아래 주소가 열리는지(JSON이 보이는지) 브라우저로 확인합니다.
   `https://<내 아이디>.github.io/babys-data/places.json`
7. 위 주소를 Claude에게 알려 주면 앱에 연결하고(`PLACES_DATA_URL`) 실제 갱신까지 확인합니다.

## 주간 예방접종 API 점검 (`check-vcninfo.yml`)

앱의 예방접종 정보는 질병관리청 API(공공데이터포털 15084296)의 글을 사람이 구조화해 앱에 넣어 둔 정적 데이터라, 일정이 개정되어도 앱은 알 수 없습니다. 이 워크플로가 **매주 월요일**(한국 시간 12시) API를 다시 호출해 기준 스냅샷(`data/kdca-vcninfo-baseline.json`)과 비교합니다.

- **변경이 없으면** 아무 일도 일어나지 않습니다(로그에 "변경 없음").
- **변경이 있으면** 바뀐 감염병과 변경 부분을 담은 **이슈**를 만듭니다. 제목의 12자리 값(다이제스트)이 같은 변경은 한 번만 알립니다.
- **점검 자체가 실패하면**(API 오류, 응답 형식 변경, 키 문제 등) 작업이 빨간색 실패가 되고 GitHub이 알림 메일을 보냅니다.
- 필요한 설정: 저장소 **Settings → Secrets and variables → Actions → New repository secret**에 이름 `DATA_GO_KR_API_KEY`, 값은 공공데이터포털 일반 인증키(Encoding/Decoding 어느 쪽이든 됩니다). 이 값은 점검 단계의 환경변수로만 쓰이고 로그에 출력되지 않습니다.
- **이슈를 받으면:** 원문으로 접종 일정 변경 여부를 확인하고, 영향이 있으면 BABYS 앱의 `vaccination.json`을 고쳐 앱을 새로 배포합니다. 확인이 끝나면 기준을 새 내용으로 바꿉니다.
  ```bash
  DATA_GO_KR_API_KEY=키 python tools/check_vcninfo.py --update-baseline    # 로컬에서, 키는 .env 에 두어도 됩니다
  ```
  그 뒤 `data/kdca-vcninfo-baseline.json`을 커밋·푸시합니다. 기준을 바꾸지 않으면 같은 변경은 다시 알리지 않고, 또 다른 변경이 생기면 새 이슈가 만들어집니다.
- 처음 설정 후 Actions 탭에서 **Check vaccination API changes → Run workflow**로 한 번 실행해 "변경 없음"으로 성공하는지 확인합니다.

## 보안 메모

- 이 저장소의 `docs/places.json`을 바꿀 수 있는 사람은 앱이 보여 주는 장소·전화번호를 바꿀 수 있습니다. 앱의 검증은 **형식만** 확인하므로(전화번호가 진짜인지는 모릅니다), 계정에 **2단계 인증**을 켜고 쓰기 권한을 가진 사람/토큰을 최소로 유지하세요.
- 워크플로의 `actions/checkout@v7`, `actions/setup-python@v7`은 태그로 고정되어 있고, 러너는 `ubuntu-24.04`로 고정했습니다(2026-10-19부터 `ubuntu-latest`가 Ubuntu 26으로 바뀐다는 GitHub 안내가 있었습니다). 더 엄격히 하려면 커밋 SHA로 고정하세요.
- 앱은 https 주소만 받고, 사용자 정보·위치는 보내지 않습니다(User-Agent도 `BABYS`만). GitHub Pages 서버에는 접속 IP가 남을 수 있습니다(앱의 정보 이용 안내에 적혀 있습니다).

## 데이터 출처 표시

서울특별시 여성가족실 아이돌봄담당관, 「서울형 키즈카페 시설현황정보」(서울 열린데이터광장 OA-21716), **공공누리 제1유형(출처표시)**.
`places.json`의 `source` 항목에 출처가 들어 있고 앱 화면에도 표시됩니다. 연락처 중 휴대전화 번호(010 등)는 개인 번호일 수 있어 일부러 뺍니다.

## 수동 점검

```bash
python tools/fetch_places.py --dry                    # 5건만 받아 구조 확인 (저장 안 함)
python tools/fetch_places.py --out docs/places.json   # 전체 수집·검증·저장
```
