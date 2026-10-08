#!/usr/bin/env python3
"""서울형 키즈카페(서울 열린데이터광장 OA-21716) 수집 → places.json.

    python tools/fetch_places.py --dry                    # 5건만 받아 구조·좌표 확인 (저장 안 함, 요청 1회)
    python tools/fetch_places.py                          # 전체(요청 1회)를 받아 검증 후 앱 번들에 places.json 저장
    python tools/fetch_places.py --out docs/places.json   # 저장 위치 지정 (데이터 저장소의 GitHub Actions 가 쓴다)

포털의 공개 조회 화면이 쓰는 주소를 쓴다. 인증키가 필요 없다. 다만 문서화된 공식 API 가 아니라 화면용 주소라 바뀔 수 있고,
응답이 JSON 이 아니라 따옴표 없는 키를 쓰는 JS 객체 표기라 parse_js_object 로 읽는다 (docs/data-sources.md 8절).
구조가 바뀌어 읽을 수 없거나 건수가 맞지 않으면 파일을 쓰지 않고 실패한다.

출력 규칙: 출처가 준 값만 싣는다. 빈 값(문자열 "null")은 null 이고, 추정해서 채우지 않는다.
휴대전화(01x) 번호는 운영자 개인 번호일 수 있어 싣지 않는다 (SPEC-places Open Questions 9).
"""
import json
import os
import re
import sys
import urllib.request
from datetime import date

VIEW_URL = (
    "https://data.seoul.go.kr/dataList/dataView.do?onepagerow=%d&srvType=S&infId=OA-21716"
    "&serviceKind=0&pageNo=1&ssUserId=SAMPLE_VIEW&strWhere=&strOrderby="
)
ALL_ROWS = 1000          # 현재 151건. 포털 화면이 한 번에 1000건까지 쓴다
SCHEMA_VERSION = 1
SOURCE = {
    "id": "seoul-kids-cafe",
    "name": "서울형 키즈카페 시설현황정보",
    "organization": "서울특별시 여성가족실 아이돌봄담당관",
    "url": "https://data.seoul.go.kr/dataList/OA-21716/S/1/datasetView.do",
    "licenseNote": "공공누리 제1유형(출처표시). 서울 열린데이터광장 OA-21716, 매월 3일 갱신",
}
DEFAULT_OUT = os.path.join(os.path.dirname(__file__), "..", "android", "app", "src", "main", "assets", "places", "places.json")

# 서울 대략 범위. 위경도가 뒤바뀌어 오는 경우(sudal 교훈)와 잘못된 좌표를 걸러낸다
LAT_RANGE = (37.4, 37.75)
LNG_RANGE = (126.7, 127.3)
MIN_KEEP_RATIO = 0.5     # 이전 건수의 절반 미만이면 수집 오류로 본다


def parse_js_object(text):
    """따옴표 없는 키를 쓰는 JS 객체 표기를 읽는다. 문자열 값 안의 내용은 건드리지 않는다."""
    tok = re.compile(r'"(?:[^"\\]|\\.)*"|[A-Za-z_]\w*(?=\s*:)|\s+|.', re.S)
    toks = [m.group(0) for m in tok.finditer(text)]
    out = []
    for i, s in enumerate(toks):
        if re.fullmatch(r"[A-Za-z_]\w*", s):
            s = '"%s"' % s
        elif s == ",":      # 닫는 괄호 바로 앞의 쉼표는 JSON 이 허용하지 않으므로 뺀다 (문자열 안의 쉼표는 토큰이 달라 영향 없음)
            nxt = next((t for t in toks[i + 1:] if not t.isspace()), "")
            if nxt in ("]", "}"):
                continue
        out.append(s)
    return json.loads("".join(out))


def coordinate_problem(lat, lng):
    """좌표가 서울 범위 안이면 None, 아니면 사유."""
    if LAT_RANGE[0] <= lat <= LAT_RANGE[1] and LNG_RANGE[0] <= lng <= LNG_RANGE[1]:
        return None
    if LAT_RANGE[0] <= lng <= LAT_RANGE[1] and LNG_RANGE[0] <= lat <= LNG_RANGE[1]:
        return "위경도 뒤바뀜"
    return "서울 범위 밖"


def clean(value):
    """앞뒤 공백을 지우고, 비었거나 문자열 "null" 이면 None."""
    if value is None:
        return None
    s = str(value).strip()
    return None if s in ("", "null") else s


def to_place(r):
    """행 하나를 앱 스키마로 바꾼다. 쓸 수 없는 행이면 ValueError(사유)."""
    required = {k: clean(r.get(k)) for k in ("FCLTY_ID", "FCLTY_NM", "ATDRC_NM", "BASS_ADRES")}
    missing = [k for k, v in required.items() if v is None]
    if missing:
        raise ValueError("필수 값 없음: " + ", ".join(missing))
    try:
        lat, lng = float(clean(r.get("Y_CRDNT_VALUE"))), float(clean(r.get("X_CRDNT_VALUE")))
    except (TypeError, ValueError):
        raise ValueError("좌표 없음")
    problem = coordinate_problem(lat, lng)
    if problem:
        raise ValueError(problem)
    phone = clean(r.get("CTTPC"))
    if phone and re.match(r"^01\d", re.sub(r"\D", "", phone)):
        phone = None
    free = clean(r.get("RNTFEE_FREE_AT"))
    return {
        "id": required["FCLTY_ID"], "name": required["FCLTY_NM"], "district": required["ATDRC_NM"],
        "address": required["BASS_ADRES"], "addressDetail": clean(r.get("DETAIL_ADRES")),
        "lat": lat, "lng": lng,
        "ageRangeText": clean(r.get("POSBL_AGRDE")), "openDays": clean(r.get("OPEN_WEEK")),
        "closedDays": clean(r.get("CLOSE_WEEK")),
        "rentalFree": None if free is None else free == "Y",
        "phone": phone,
    }


def build_places(rows):
    """(장소 목록 id 순, 제외·중복 보고 목록). 쓸 수 없는 행은 빼고 사유를 남긴다."""
    places, problems, seen = [], [], set()
    for r in rows:
        rid = clean(r.get("FCLTY_ID")) or "(id 없음)"
        try:
            p = to_place(r)
        except ValueError as e:
            problems.append("%s: %s" % (rid, e))
            continue
        if p["id"] in seen:
            problems.append("%s: 중복 id, 첫 행만 사용" % rid)
            continue
        seen.add(p["id"])
        places.append(p)
    return sorted(places, key=lambda p: p["id"]), problems


def build_snapshot(rows, today):
    places, _ = build_places(rows)
    updated = [r["UPDT_DT"][:10] for r in rows if clean(r.get("UPDT_DT"))]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": today,
        "dataUpdatedAt": max(updated) if updated else None,
        "source": dict(SOURCE, baseDate=today + " 수집"),
        "places": places,
    }


def dumps_snapshot(snap):
    """장소 하나를 한 줄로 쓴다(변경 비교가 쉽다). 같은 입력은 같은 출력."""
    head = {k: v for k, v in snap.items() if k != "places"}
    lines = [json.dumps(p, ensure_ascii=False) for p in snap["places"]]
    body = ",\n    ".join(lines)
    head_text = json.dumps(head, ensure_ascii=False, indent=2)
    return head_text[:-2] + ',\n  "places": [\n    ' + body + "\n  ]\n}\n"


def check_safety(new_count, old_count):
    if new_count == 0:
        sys.exit("실패: 장소가 0건이라 파일을 쓰지 않는다")
    if old_count and new_count < old_count * MIN_KEEP_RATIO:
        sys.exit("실패: 이전 %d건 → %d건으로 절반 미만이라 파일을 쓰지 않는다" % (old_count, new_count))


def check_complete(received, total):
    if received != total:
        sys.exit("실패: 총 %d건인데 %d건만 받았다(한 번에 받는 건수 제한?)" % (total, received))


def fetch(rows):
    with urllib.request.urlopen(VIEW_URL % rows, timeout=60) as r:
        d = parse_js_object(r.read().decode("utf-8"))
    if not isinstance(d.get("list"), list) or "page" not in d:
        sys.exit("실패: 응답 구조가 달라졌다(list/page 없음)")
    return d


def dry():
    d = fetch(5)
    rows = d["list"]
    print("총 건수:", d["page"]["totalCount"], "/ 받은 건수:", len(rows))
    print("컬럼:", ", ".join(sorted(rows[0])))
    places, problems = build_places(rows)
    for p in places:
        print("-", p["name"], "|", p["district"], "|", p["ageRangeText"])
    for x in problems:
        print("! 제외:", x)


def old_count(path):
    try:
        with open(path, encoding="utf-8") as f:
            return len(json.load(f)["places"])
    except (OSError, ValueError, KeyError):
        return None


def parse_out(argv):
    """--out 뒤의 저장 경로. 없으면 앱 번들 경로."""
    if "--out" not in argv:
        return DEFAULT_OUT
    i = argv.index("--out")
    if i + 1 >= len(argv):
        sys.exit("--out 뒤에 저장 경로가 필요하다")
    return argv[i + 1]


def write_atomic(path, text):
    """임시 파일에 쓴 뒤 교체한다. 도중에 실패해도 기존 파일은 그대로다."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)


def run(out, fetcher=fetch):
    d = fetcher(ALL_ROWS)
    rows = d["list"]
    check_complete(len(rows), int(d["page"]["totalCount"]))
    snap = build_snapshot(rows, date.today().isoformat())
    _, problems = build_places(rows)
    for x in problems:
        print("! 제외:", x)
    check_safety(len(snap["places"]), old_count(out))
    write_atomic(out, dumps_snapshot(snap))
    print("저장: %d건 (받은 %d건, 제외 %d건) → %s" % (len(snap["places"]), len(rows), len(problems), os.path.normpath(out)))


if __name__ == "__main__":
    if "--dry" in sys.argv:
        dry()
    else:
        run(parse_out(sys.argv))
