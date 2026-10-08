#!/usr/bin/env python3
"""질병관리청 예방접종 API(공공데이터포털 15084296) 변경 점검.

앱의 예방접종 시드는 이 API의 감염병별 글을 사람이 구조화한 정적 데이터다. 보건 당국이 일정을 개정해도 앱은 알 수 없으므로,
주 1회 API를 다시 호출해 기준(baseline) 스냅샷과 비교하고 **달라졌을 때만** 알린다(GitHub Actions 가 이슈를 만든다).

    python tools/check_vcninfo.py                     # 점검 (변경 없으면 종료코드 0, 있으면 10, 오류 2)
    python tools/check_vcninfo.py --update-baseline   # 변경을 확인·반영한 뒤 기준을 새 내용으로 바꾼다

인증키는 환경변수 DATA_GO_KR_API_KEY (없으면 현재 폴더의 .env). 키는 어디에도 출력·기록하지 않는다(오류 메시지에서도 지운다).
호출은 목록 1회 + 감염병별 상세 21회 안팎(개발계정 하루 10,000건 한도의 0.3%). 표준 라이브러리만 쓴다.
"""
import argparse
import difflib
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import namedtuple
from datetime import date

BASE_URL = "https://apis.data.go.kr/1790387/vcninfo"
KEY_NAME = "DATA_GO_KR_API_KEY"
DEFAULT_BASELINE = os.path.join("data", "kdca-vcninfo-baseline.json")
EXIT_SAME, EXIT_CHANGED, EXIT_ERROR = 0, 10, 2


class CheckError(Exception):
    """점검을 끝까지 할 수 없는 오류(호출 실패, 응답 형식 변경, 기준 파일 문제 등)."""


def norm(text):
    """HTML 엔티티를 풀고 연속 공백·줄바꿈을 한 칸으로 정리한다(서식만 바뀐 것은 변경으로 보지 않는다)."""
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def _check_header(xml):
    m = re.search(r"<resultCode>(.*?)</resultCode>", xml)
    if not m:
        raise CheckError("응답 형식이 아니다(resultCode 없음)")
    if m.group(1).strip() != "00":
        raise CheckError("API 결과코드 %s" % m.group(1).strip())


def parse_list(xml):
    _check_header(xml)
    pairs = [(norm(a), norm(b)) for a, b in re.findall(r"<item>\s*<cd>(.*?)</cd>\s*<cdNm>(.*?)</cdNm>\s*</item>", xml, re.S)]
    if not pairs:
        raise CheckError("감염병 목록이 비어 있다")
    return pairs


def parse_detail(xml):
    _check_header(xml)
    t = re.search(r"<title>(.*?)</title>", xml, re.S)
    m = re.search(r"<message><!\[CDATA\[(.*?)\]\]></message>", xml, re.S) or re.search(r"<message>(.*?)</message>", xml, re.S)
    if not t or not m:
        raise CheckError("감염병 상세 응답에 title/message 가 없다")
    return norm(t.group(1)), norm(m.group(1))


def fetch_all(call, sleep=time.sleep):
    """{제목: 본문}. 하나라도 못 받으면 CheckError (일부만 믿고 비교하지 않는다)."""
    out = {}
    for cd, _name in parse_list(call("getCondVcnCd", pageNo=1, numOfRows=100)):
        title, message = parse_detail(call("getVcnInfo", vcnCd=cd, pageNo=1, numOfRows=1))
        if title in out:
            raise CheckError("제목이 겹치는 감염병이 있다: %s" % title)
        out[title] = message
        sleep(0.3)
    return out


def normalized(diseases):
    """{코드: (제목, 본문)} → {정리된 제목: 정리된 본문} (시험용 도우미)."""
    return {norm(t): norm(m) for t, m in diseases.values()}


Result = namedtuple("Result", "changed_titles added removed")


class _Compare(Result):
    @property
    def changed(self):
        return bool(self.changed_titles or self.added or self.removed)


def compare(old, new):
    return _Compare(
        changed_titles=sorted(t for t in set(old) & set(new) if old[t] != new[t]),
        added=sorted(set(new) - set(old)),
        removed=sorted(set(old) - set(new)),
    )


def digest(diseases):
    """내용이 같으면 같은 12자리 값. 같은 변경으로 알림이 중복되지 않게 이슈 제목에 쓴다."""
    blob = "\n".join("%s\n%s" % (t, m) for t, m in sorted(diseases.items()))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]


def _snippets(a, b, limit=3, width=160):
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    rows = []
    for tag, a1, a2, b1, b2 in sm.get_opcodes():
        if tag == "equal":
            continue
        rows.append((a[max(0, a1 - 25):a2 + 25][:width], b[max(0, b1 - 25):b2 + 25][:width]))
        if len(rows) >= limit:
            break
    return rows


def make_report(result, old, new, today):
    d = digest(new)
    lines = [
        "# 예방접종 API 변경 감지 (%s)" % d,
        "",
        "- 점검일: %s" % today,
        "- 기준과 비교: 본문이 바뀐 감염병 %d종, 새로 생긴 감염병 %d종, 사라진 감염병 %d종" % (len(result.changed_titles), len(result.added), len(result.removed)),
        "- 출처: 공공데이터포털 15084296(질병관리청 예방접종 대상 감염병 정보 API)",
        "",
    ]
    if result.added:
        lines += ["## 새로 생긴 감염병", ""] + ["- %s" % t for t in result.added] + [""]
    if result.removed:
        lines += ["## 사라진 감염병", ""] + ["- %s" % t for t in result.removed] + [""]
    if result.changed_titles:
        lines += ["## 본문이 바뀐 감염병 (변경 부분 일부)", ""]
        for t in result.changed_titles:
            lines.append("### %s" % t)
            for before, after in _snippets(old[t], new[t]):
                lines += ["- 이전: `%s`" % before.replace("`", "'"), "- 이후: `%s`" % after.replace("`", "'")]
            lines.append("")
    lines += [
        "## 해야 할 일",
        "",
        "1. 변경이 접종 일정(대상·시기·회차)에 영향을 주는지 원문(공공데이터포털 API 응답, 질병관리청 예방접종도우미)으로 확인한다.",
        "2. 영향이 있으면 BABYS 앱의 `vaccination.json` 시드를 고치고 앱을 새로 배포한다(사람이 구조화한 값이라 자동으로 바뀌지 않는다).",
        "3. 확인을 마치면 이 점검의 기준을 새 내용으로 바꾼다: `python tools/check_vcninfo.py --update-baseline` 후 `data/kdca-vcninfo-baseline.json`을 커밋한다. 기준을 바꾸지 않으면 같은 변경은 한 번만 알리고(이슈 제목의 %s) 이후에는 조용하다." % d,
    ]
    return "\n".join(lines) + "\n"


def redact(text, key):
    """오류 메시지·출력에서 인증키를 지운다(원문·퍼센트 인코딩·serviceKey= 뒤의 값 모두)."""
    out = text
    if key:
        for variant in {key, urllib.parse.unquote(key), urllib.parse.quote(key, safe=""), urllib.parse.quote_plus(key)}:
            if variant:
                out = out.replace(variant, "<키>")
    return re.sub(r"(serviceKey=)[^&\s\"'<>]+", r"\1<키>", out)


def load_key(env, env_file=".env"):
    value = (env.get(KEY_NAME) or "").strip()
    if not value and env_file and os.path.isfile(env_file):
        with open(env_file, encoding="utf-8") as f:
            for line in f:
                m = re.match(r"\s*%s\s*=\s*(.*?)\s*$" % KEY_NAME, line)
                if m:
                    value = m.group(1).strip().strip("'\"")
    if not value:
        raise CheckError("%s 가 없다(환경변수 또는 .env). GitHub Actions 에서는 저장소 Secrets 에 등록한다" % KEY_NAME)
    return value


def make_call(key):
    # 포털이 주는 키는 이미 URL 인코딩된 형태일 수 있어 한 번 풀어서 다시 인코딩한다(이중 인코딩 방지)
    plain = urllib.parse.unquote(key)

    def call(op, **params):
        query = urllib.parse.urlencode({"serviceKey": plain, **params})
        try:
            with urllib.request.urlopen("%s/%s?%s" % (BASE_URL, op, query), timeout=40) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # 주소(키 포함)가 메시지에 섞이지 않게 종류와 상태코드만 남긴다
            raise CheckError("호출 실패(%s): %s %s" % (op, type(e).__name__, getattr(e, "code", "")))

    return call


def save_baseline(path, diseases, today):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    data = {"checkedAt": today, "digest": digest(diseases), "diseases": dict(sorted(diseases.items()))}
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, path)


def load_baseline(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        diseases = data["diseases"]
        if not isinstance(diseases, dict) or not diseases:
            raise ValueError
    except (OSError, ValueError, KeyError, TypeError):
        raise CheckError("기준 파일을 읽을 수 없다: %s (`--update-baseline` 으로 만든다)" % path)
    if data.get("digest") != digest(diseases):
        raise CheckError("기준 파일의 내용과 다이제스트가 맞지 않는다(손상 또는 손으로 고침): %s" % path)
    return diseases


def _write(path, text):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def main(argv=None, env=None, call=None, sleep=time.sleep, today=None, env_file=".env"):
    ap = argparse.ArgumentParser(description="예방접종 API 변경 점검")
    ap.add_argument("--baseline", default=DEFAULT_BASELINE, help="기준 스냅샷 파일")
    ap.add_argument("--report", help="변경이 있을 때 보고서(마크다운)를 쓸 경로")
    ap.add_argument("--digest-file", help="변경이 있을 때 12자리 다이제스트를 쓸 경로")
    ap.add_argument("--update-baseline", action="store_true", help="새로 받은 내용으로 기준을 바꾼다")
    args = ap.parse_args(argv)
    env = os.environ if env is None else env
    today = today or date.today().isoformat()
    key = None
    try:
        key = load_key(env, env_file)
        new = fetch_all(call or make_call(key), sleep)
        if args.update_baseline:
            save_baseline(args.baseline, new, today)
            print("기준을 갱신했다: %d종 (%s)" % (len(new), digest(new)))
            return EXIT_SAME
        old = load_baseline(args.baseline)
        result = compare(old, new)
        if not result.changed:
            print("변경 없음: %d종 모두 기준과 같다" % len(new))
            return EXIT_SAME
        print("변경 감지: 바뀜 %d종, 추가 %d종, 삭제 %d종 (%s)" % (len(result.changed_titles), len(result.added), len(result.removed), digest(new)))
        if args.report:
            _write(args.report, make_report(result, old, new, today))
        if args.digest_file:
            _write(args.digest_file, digest(new) + "\n")
        return EXIT_CHANGED
    except CheckError as e:
        print("점검 실패: " + redact(str(e), key), file=sys.stderr)
        return EXIT_ERROR
    except Exception as e:  # 어떤 예외든 키가 새지 않게 지우고 오류로 끝낸다
        print("점검 실패(예상하지 못한 오류): %s: %s" % (type(e).__name__, redact(str(e), key)), file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
