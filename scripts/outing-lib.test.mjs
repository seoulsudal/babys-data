// 실행: node --test scripts/   (표준 라이브러리만 쓴다)
// 아래 항목·이름·좌표는 모두 검증용 가상 값이며 실제 장소·행사가 아니다.
import test from "node:test";
import assert from "node:assert/strict";
import {
  stripHtml, extractUrl, pickLatLng, fillDistrict, dedupe, applyOverrides,
  tourEventCandidate, tourPlaceCandidate, seoulEventItem, tourItem, slimItem, sameItems, guardCount,
} from "./outing-lib.mjs";

const TODAY = "2026-10-18";
const UNTIL = "2027-01-16";

test("stripHtml: 태그·엔티티·공백을 정리한다", () => {
  assert.equal(stripHtml("가<br/>나 &amp; <b>다</b>&nbsp; 라"), "가 나 & 다 라");
  assert.equal(stripHtml(null), "");
});

test("extractUrl: href 또는 본문의 http(s) 주소만 꺼낸다", () => {
  assert.equal(extractUrl('<a href="https://example.com/a">사이트</a>'), "https://example.com/a");
  assert.equal(extractUrl("문의 http://example.com/x 로"), "http://example.com/x");
  assert.equal(extractUrl('<a href="javascript:alert(1)">x</a>'), null);
  assert.equal(extractUrl("example.com"), null);
  assert.equal(extractUrl(""), null);
});

test("pickLatLng: 값의 범위로 위도·경도를 가리고 이상하면 null", () => {
  assert.deepEqual(pickLatLng(37.5, 127.0), { lat: 37.5, lng: 127.0 });
  assert.deepEqual(pickLatLng(127.0, 37.5), { lat: 37.5, lng: 127.0 });   // 뒤바뀐 경우
  assert.deepEqual(pickLatLng(0, 0), { lat: null, lng: null });
  assert.deepEqual(pickLatLng("abc", 127), { lat: null, lng: null });
  assert.deepEqual(pickLatLng(10, 20), { lat: null, lng: null });
});

test("fillDistrict: 비어 있으면 주소에서 시군구를 뽑는다", () => {
  assert.equal(fillDistrict({ district: "가나구", address: "서울 다라구 1" }).district, "가나구");
  assert.equal(fillDistrict({ district: null, address: "경기 과천시 시험로 1" }).district, "과천시");
  assert.equal(fillDistrict({ district: null, address: "" }).district, null);
});

test("dedupe: 같은 제목·시작일이면 서울 자료를 우선한다", () => {
  const a = { title: "가 행사", startDate: "2026-10-20", source: "tour", id: "t" };
  const b = { title: "가  행사", startDate: "2026-10-20", source: "seoul", id: "s" };
  assert.deepEqual(dedupe([a, b]).map((i) => i.id), ["s"]);
  assert.deepEqual(dedupe([b, a]).map((i) => i.id), ["s"]);
  const other = { title: "다른", startDate: "2026-10-20", source: "tour", id: "o" };
  assert.equal(dedupe([a, other]).length, 2);
});

test("applyOverrides: exclude·patch·add", () => {
  const items = [{ id: "a", title: "A" }, { id: "b", title: "B" }];
  const out = applyOverrides(items, { exclude: ["a"], patch: { b: { title: "B2" } }, add: [{ id: "m", title: "M", type: "place", region: "서울" }] });
  assert.deepEqual(out.map((i) => [i.id, i.title, i.source]), [["b", "B2", undefined], ["m", "M", "manual"]]);
  assert.equal(applyOverrides(items, {}).length, 2);
});

test("tourEventCandidate: 기간·성인 전용·아이 관련 단어를 본다", () => {
  const ok = { title: "어린이 가족 축제", eventstartdate: "20261020", eventenddate: "20261025", contentid: "1", contenttypeid: "15" };
  assert.deepEqual(tourEventCandidate(ok, TODAY, UNTIL), { start: "2026-10-20", end: "2026-10-25" });
  assert.equal(tourEventCandidate({ ...ok, eventenddate: "20261010" }, TODAY, UNTIL), null);       // 이미 끝남
  assert.notEqual(tourEventCandidate({ ...ok, eventstartdate: "20261010", eventenddate: "20261018" }, TODAY, UNTIL), null);   // 종료일이 오늘이면 아직 진행 중
  assert.notEqual(tourEventCandidate({ ...ok, eventstartdate: "20270116", eventenddate: "20270120" }, TODAY, UNTIL), null);   // 시작일이 window 끝날이면 포함
  assert.equal(tourEventCandidate({ ...ok, eventstartdate: "20270301", eventenddate: "20270302" }, TODAY, UNTIL), null);   // 너무 먼 미래
  assert.equal(tourEventCandidate({ ...ok, title: "와인 가족 축제" }, TODAY, UNTIL), null);          // 성인 전용
  assert.equal(tourEventCandidate({ ...ok, title: "음악 공연" }, TODAY, UNTIL), null);              // 아이 단어 없음
});

test("tourPlaceCandidate: 관광지·문화시설·레포츠만, 성인 전용 제외", () => {
  assert.equal(tourPlaceCandidate({ title: "구름 놀이터", contenttypeid: "12" }), true);
  assert.equal(tourPlaceCandidate({ title: "구름 놀이터", contenttypeid: "39" }), false);      // 음식점
  assert.equal(tourPlaceCandidate({ title: "맥주 체험관", contenttypeid: "14" }), false);
});

test("seoulEventItem: 기간·성인·온라인·아이 단어를 거르고 필요한 필드만 만든다", () => {
  const row = {
    TITLE: "어린이 인형극", STRTDATE: "2026-10-20 00:00:00.0", END_DATE: "2026-10-21 00:00:00.0", PLACE: "시험문화회관", GUNAME: "가나구",
    USE_TRGT: "누구나", CODENAME: "연극", LAT: "127.0", LOT: "37.5", ORG_LINK: '<a href="https://example.com/e">x</a>', PROGRAM: "설명", MAIN_IMG: "http://x/y.jpg",
  };
  const it = seoulEventItem(row, TODAY, UNTIL);
  assert.equal(it.type, "event");
  assert.equal(it.source, "seoul");
  assert.equal(it.region, "서울");
  assert.equal(it.startDate, "2026-10-20");
  assert.equal(it.endDate, "2026-10-21");
  assert.deepEqual([it.lat, it.lng], [37.5, 127.0]);                 // LAT/LOT 가 뒤바뀌어 와도 바로잡는다
  assert.equal(it.officialUrl, "https://example.com/e");
  assert.match(it.id, /^seoul-[0-9a-f]{10}$/);
  assert.equal(seoulEventItem(row, TODAY, UNTIL).id, it.id);        // 같은 입력은 같은 id
  assert.equal(seoulEventItem({ ...row, END_DATE: "2026-10-10" }, TODAY, UNTIL), null);
  assert.notEqual(seoulEventItem({ ...row, STRTDATE: "2026-10-10", END_DATE: "2026-10-18 00:00:00.0" }, TODAY, UNTIL), null);   // 종료일이 오늘
  assert.equal(seoulEventItem({ ...row, USE_TRGT: "성인" }, TODAY, UNTIL), null);
  assert.equal(seoulEventItem({ ...row, TITLE: "[온라인] 어린이 인형극" }, TODAY, UNTIL), null);
  assert.equal(seoulEventItem({ ...row, TITLE: "음악회", CODENAME: "콘서트" }, TODAY, UNTIL), null);
});

test("tourItem: 장소·행사를 앱 모양으로 만든다(휴대전화 번호는 뺀다)", () => {
  const raw = { contentid: "77", title: " 구름 <b>놀이터</b> ", addr1: "서울 가나구 시험로 1", addr2: "", mapy: "37.5", mapx: "127.0", tel: "010-1234-5678" };
  const detail = { overview: "설명", homepage: "https://example.com/p" };
  const place = tourItem({ raw, kind: "place", region: "서울" }, detail);
  assert.equal(place.id, "tour-77");
  assert.equal(place.title, "구름 놀이터");
  assert.equal(place.tel, null);
  assert.equal(place.startDate, undefined);
  const event = tourItem({ raw: { ...raw, tel: "02-123-4567" }, kind: "event", region: "경기", start: "2026-10-20", end: "2026-10-25" }, detail);
  assert.equal(event.type, "event");
  assert.equal(event.tel, "02-123-4567");
  assert.equal(event.startDate, "2026-10-20");
});

test("slimItem: 앱이 쓰지 않는 필드는 담지 않는다", () => {
  const it = slimItem({ id: "a", type: "place", title: "T", region: "서울", district: "가나구", address: "A", lat: 37.5, lng: 127, image: "x", ages: ["all"], isFree: true, indoor: false, officialUrl: null, tel: null, source: "tour", summary: "S", extra: 1 });
  for (const k of ["image", "ages", "isFree", "indoor", "extra"]) assert.equal(k in it, false, k);
  assert.equal(it.summary, "S");
});

test("sameItems: 내용이 같으면 같다(순서·updatedAt 무관)", () => {
  const a = [{ id: "1", title: "A" }, { id: "2", title: "B" }];
  assert.equal(sameItems(a, JSON.parse(JSON.stringify(a))), true);
  assert.equal(sameItems(a, [{ id: "1", title: "A" }, { id: "2", title: "C" }]), false);
  assert.equal(sameItems(a, [a[0]]), false);
});

test("guardCount: 0건이거나 지금의 절반 미만이면 덮어쓰지 않는다", () => {
  assert.equal(guardCount(0, 0), false);
  assert.equal(guardCount(100, 0), false);
  assert.equal(guardCount(100, 49), false);
  assert.equal(guardCount(100, 50), true);
  assert.equal(guardCount(0, 5), true);          // 처음 만들 때
});
