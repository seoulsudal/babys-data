// 약국 탐색(달빛병원 근처 약국 분류) 순수 함수 시험. 아래 약국·좌표는 모두 검증용 가상 값이며 실제 약국이 아니다.
import test from "node:test";
import assert from "node:assert/strict";
import { distanceMeters, hoursOfRaw, classifyHours, pharmacyKey, summarize, countDistribution, uniqueNearby, nearestHospital, pharmacyItem } from "./pharmacy-lib.mjs";

test("두 좌표 사이의 직선거리(m)", () => {
  assert.equal(Math.round(distanceMeters(37.5, 127.0, 37.5, 127.0)), 0);
  const d = distanceMeters(37.5, 127.0, 37.5009, 127.0);          // 위도 0.0009° ≈ 100m
  assert.ok(d > 95 && d < 105, String(d));
  const e = distanceMeters(37.5, 127.0, 37.5, 127.0011);          // 경도 0.0011° ≈ 97m (위도 37.5°)
  assert.ok(e > 90 && e < 105, String(e));
});

test("요일별 시각 8칸을 읽는다(월~일·공휴일, 형식이 틀리면 null, 숫자로 온 시각도 읽는다)", () => {
  const h = hoursOfRaw({ dutyTime1s: "0900", dutyTime1c: "2100", dutyTime6s: "0900", dutyTime6c: "1800", dutyTime8s: "9시", dutyTime8c: "1800" });
  assert.deepEqual(h, ["0900-2100", null, null, null, null, "0900-1800", null, null]);
  // 실제 응답은 숫자(1900)와 앞자리 0이 있는 문자열("0900")이 섞여 오고, 앞자리 0이 빠진 숫자(900)도 올 수 있다
  const mixed = hoursOfRaw({ dutyTime1s: 1000, dutyTime1c: 1900, dutyTime2s: 900, dutyTime2c: 1800, dutyTime6s: "0900", dutyTime6c: 1400 });
  assert.deepEqual(mixed, ["1000-1900", "0900-1800", null, null, null, "0900-1400", null, null]);
});

test("분류: 평일 18시 이후·22시 이후·주말·공휴일 운영 여부와 평일 종료 시각의 최댓값", () => {
  const night = ["0900-2300", "0900-2300", "0900-2300", "0900-2300", "0900-2300", "0900-1800", null, null];
  assert.deepEqual(classifyHours(night), { weekdayAfter18: true, weekdayAfter22: true, weekend: true, holiday: false, maxClose: 2300 });
  const day = ["0900-1800", "0900-1800", "0900-1800", "0900-1800", "0900-1800", null, null, null];
  assert.deepEqual(classifyHours(day), { weekdayAfter18: false, weekdayAfter22: false, weekend: false, holiday: false, maxClose: 1800 });     // 종료 18:00 정각은 "이후"가 아니다
  const mid = ["0900-1830", null, null, null, null, null, null, "1000-1500"];
  assert.deepEqual(classifyHours(mid), { weekdayAfter18: true, weekdayAfter22: false, weekend: false, holiday: true, maxClose: 1830 });
  assert.deepEqual(classifyHours(Array(8).fill(null)), { weekdayAfter18: false, weekdayAfter22: false, weekend: false, holiday: false, maxClose: 0 });
  assert.equal(classifyHours(["0900-2400", ...Array(7).fill(null)]).weekdayAfter22, true);                                                      // 24:00(자정)까지
  const overnight = classifyHours(["1000-0200", ...Array(7).fill(null)]);                                                                         // 자정을 넘겨 다음 날 02:00까지
  assert.equal(overnight.weekdayAfter22, true);
  assert.equal(overnight.maxClose, 2600);
});

test("약국 식별: hpid 가 있으면 그것, 없으면 이름+주소", () => {
  assert.equal(pharmacyKey({ hpid: "C1", dutyName: "가 약국", dutyAddr: "서울 가나구 1" }), "C1");
  assert.equal(pharmacyKey({ dutyName: " 가 약국 ", dutyAddr: "서울 가나구 1" }), "가 약국|서울 가나구 1");
  assert.equal(pharmacyKey({}), null);
});

test("요약: 병원마다 반경 안 약국을 분류해 세고, 가장 늦게 끝나는 약국으로 병원을 나눈다", () => {
  const c = (o) => ({ weekdayAfter18: false, weekdayAfter22: false, weekend: false, holiday: false, maxClose: 0, ...o });
  const rows = [
    { name: "병원A", pharmacies: [
      { meters: 300, c: c({ weekdayAfter18: true, weekdayAfter22: true, weekend: true, holiday: true, maxClose: 2300 }) },
      { meters: 800, c: c({ weekdayAfter18: true, maxClose: 1900 }) },
    ] },
    { name: "병원B", pharmacies: [
      { meters: 400, c: c({ weekend: true, maxClose: 1800 }) },
      { meters: 900, c: c({ weekdayAfter18: true, maxClose: 2100 }) },
    ] },
    { name: "병원C", pharmacies: [] },
  ];
  const s = summarize(rows, [500, 1000]);
  assert.equal(s.hospitals, 3);
  assert.deepEqual(s.byRadius[500], { anyPharmacy: 2, weekdayAfter18: 1, weekdayAfter22: 1, weekend: 2, holiday: 1 });
  assert.deepEqual(s.byRadius[1000], { anyPharmacy: 2, weekdayAfter18: 2, weekdayAfter22: 1, weekend: 2, holiday: 1 });
  assert.deepEqual(s.closeBuckets[500], { none: 1, noLate: 1, b18to20: 0, b20to22: 0, b22plus: 1 });
  assert.deepEqual(s.closeBuckets[1000], { none: 1, noLate: 0, b18to20: 0, b20to22: 1, b22plus: 1 });
  assert.deepEqual(s.noWeekdayAfter18Within1000, ["병원C"]);
  assert.deepEqual(s.after18CountsWithin1000, [2, 1, 0]);
});

test("요약: 이름이 같은 병원도 따로 센다(병원마다 약국 수 목록은 순서대로 모두 담는다)", () => {
  const c = { weekdayAfter18: true, weekdayAfter22: false, weekend: false, holiday: false, maxClose: 1900 };
  const rows = [
    { name: "같은 이름", pharmacies: [{ meters: 100, c }, { meters: 200, c }] },
    { name: "같은 이름", pharmacies: [{ meters: 300, c }] },
    { name: "다른 이름", pharmacies: [] },
  ];
  const s = summarize(rows, [1000]);
  assert.deepEqual(s.after18CountsWithin1000, [2, 1, 0]);
  assert.equal(s.hospitals, 3);
});

test("분포: 병원별 약국 수를 구간으로 나누고 최댓값·중앙값을 구한다", () => {
  const d = countDistribution([0, 0, 1, 4, 5, 9, 10, 19, 20, 57]);
  assert.deepEqual(d.buckets, { "0곳": 2, "1~4곳": 2, "5~9곳": 2, "10~19곳": 2, "20곳 이상": 2 });
  assert.equal(d.max, 57);
  assert.equal(d.median, 9);                       // 정렬한 뒤 가운데(짝수 개면 위쪽) 값
  assert.deepEqual(countDistribution([]), { buckets: { "0곳": 0, "1~4곳": 0, "5~9곳": 0, "10~19곳": 0, "20곳 이상": 0 }, max: 0, median: 0 });
});

test("전체 합계: 여러 병원 근처에서 겹치는 약국을 한 번만 세고, 종료 시각·주말·공휴일 기준별로 센다", () => {
  const c = (o) => ({ weekdayAfter18: false, weekdayAfter22: false, weekend: false, holiday: false, maxClose: 0, ...o });
  const late = c({ weekdayAfter18: true, weekdayAfter22: true, weekend: true, holiday: true, maxClose: 2300 });
  const mid = c({ weekdayAfter18: true, maxClose: 1900 });
  const early = c({ maxClose: 1700 });
  const rows = [
    { name: "병원A", pharmacies: [{ key: "P1", meters: 100, c: late }, { key: "P2", meters: 700, c: mid }, { key: "P3", meters: 900, c: early }] },
    { name: "병원B", pharmacies: [{ key: "P1", meters: 300, c: late }, { key: "P4", meters: 1500, c: late }, { key: "P5", meters: 400, c: mid }, { key: "P6", meters: 450, c: c({ weekdayAfter18: true, maxClose: 2000 }) }] },
  ];
  const u = uniqueNearby(rows, [500, 1000]);
  assert.deepEqual(u[500], { all: 3, after18: 3, after20: 2, after22: 1, midnight: 0, weekend: 1, holiday: 1 });       // P1(병원A 100m·병원B 300m 에서 겹침, 한 번만), P5(400m), P6(450m, 정확히 20시에 종료 → 20시 이후까지에 든다)
  assert.deepEqual(u[1000], { all: 5, after18: 4, after20: 2, after22: 1, midnight: 0, weekend: 1, holiday: 1 });      // P1, P2, P3, P5 (P4 는 1.5km)
});

const HOSPITALS = [
  { id: "H1", name: "병원A", lat: 37.5, lng: 127.0 },
  { id: "H2", name: "병원B", lat: 37.6, lng: 127.0 },
  { id: "H3", name: "좌표없음", lat: null, lng: null },
];

test("가장 가까운 달빛병원: 반경 안이면 병원과 거리(m, 반올림), 밖이면 null, 좌표 없는 병원은 무시", () => {
  const n = nearestHospital(37.5009, 127.0, HOSPITALS, 1000);          // 병원A 에서 약 100m
  assert.equal(n.id, "H1");
  assert.equal(n.name, "병원A");
  assert.ok(Number.isInteger(n.meters) && n.meters >= 95 && n.meters <= 105, String(n.meters));
  assert.equal(nearestHospital(37.55, 127.0, HOSPITALS, 1000), null);   // 병원A 에서 약 5.5km
  assert.equal(nearestHospital(37.5, 127.0, [HOSPITALS[2]], 1000), null);
  assert.equal(nearestHospital(37.57, 127.0, HOSPITALS, 8000).id, "H2");  // 병원B(약 3.3km)가 병원A(약 7.8km)보다 가깝다
});

test("약국 항목 변환: 앱이 쓰는 필드만, 시각은 8칸, 시도·시군구는 주소에서, 공백 정리", () => {
  const raw = {
    hpid: "C1", dutyName: " 가나 온누리약국 ", dutyAddr: "서울특별시 가나구   시험로 5 (시험동)", dutyTel1: "02-123-4567",
    dutyTime1s: 900, dutyTime1c: 2200, dutyTime2s: "0900", dutyTime2c: 2200, dutyTime6s: "0900", dutyTime6c: 1400,
    wgs84Lat: 37.5009, wgs84Lon: 127.0, rnum: 1, postCdn1: 100,
  };
  const near = { id: "H1", name: "병원A", meters: 100 };
  assert.deepEqual(pharmacyItem(raw, near), {
    id: "C1", name: "가나 온누리약국", address: "서울특별시 가나구 시험로 5 (시험동)", sido: "서울", district: "가나구",
    lat: 37.5009, lng: 127.0, tel: "02-123-4567",
    hours: ["0900-2200", "0900-2200", null, null, null, "0900-1400", null, null],
    near,
  });
  assert.equal(pharmacyItem({ ...raw, hpid: "" }, near), null);                                      // 기관ID 없음
  assert.equal(pharmacyItem({ ...raw, dutyName: " " }, near), null);                                 // 이름 없음
  assert.equal(pharmacyItem({ ...raw, dutyTel1: "010-1234-5678" }, near).tel, null);                 // 휴대전화는 쓰지 않는다
});

