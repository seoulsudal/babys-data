# babys-data (BABYS 장소 데이터)

BABYS 앱이 내려받아 쓰는 **서울형 키즈카페 목록**(`docs/places.json`)을 매월 자동으로 갱신해 GitHub Pages로 게시하는 저장소입니다.
이 폴더(`deploy/places-data/`)는 BABYS 저장소 안의 **복사해 갈 원본**이고, 실제로는 별도의 공개 저장소로 만들어 씁니다.

## 구성

```
.github/workflows/update-places.yml   매월 4일(+수동) 수집 → 검증 → 바뀌었을 때만 커밋
tools/fetch_places.py                 수집·검증 스크립트 (BABYS의 tools/fetch_places.py 와 같은 파일)
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

## 보안 메모

- 이 저장소의 `docs/places.json`을 바꿀 수 있는 사람은 앱이 보여 주는 장소·전화번호를 바꿀 수 있습니다. 앱의 검증은 **형식만** 확인하므로(전화번호가 진짜인지는 모릅니다), 계정에 **2단계 인증**을 켜고 쓰기 권한을 가진 사람/토큰을 최소로 유지하세요.
- 워크플로의 `actions/checkout@v4`, `actions/setup-python@v5`는 태그로 고정되어 있습니다. 더 엄격히 하려면 커밋 SHA로 고정하세요.
- 앱은 https 주소만 받고, 사용자 정보·위치는 보내지 않습니다(User-Agent도 `BABYS`만). GitHub Pages 서버에는 접속 IP가 남을 수 있습니다(앱의 정보 이용 안내에 적혀 있습니다).

## 데이터 출처 표시

서울특별시 여성가족실 아이돌봄담당관, 「서울형 키즈카페 시설현황정보」(서울 열린데이터광장 OA-21716), **공공누리 제1유형(출처표시)**.
`places.json`의 `source` 항목에 출처가 들어 있고 앱 화면에도 표시됩니다. 연락처 중 휴대전화 번호(010 등)는 개인 번호일 수 있어 일부러 뺍니다.

## 수동 점검

```bash
python tools/fetch_places.py --dry                    # 5건만 받아 구조 확인 (저장 안 함)
python tools/fetch_places.py --out docs/places.json   # 전체 수집·검증·저장
```
