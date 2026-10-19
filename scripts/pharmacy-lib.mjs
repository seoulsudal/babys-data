// 달빛병원 근처 약국 분류용 순수 함수(국립중앙의료원 「전국 약국 정보 조회 서비스」 응답 → 분류).
import { hoursOf, sidoOf } from "./moonlight-lib.mjs";
import { stripHtml } from "./outing-lib.mjs";

const EARTH_M = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

/** 두 좌표 사이의 직선거리(m). */
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(a));
}

// 응답은 숫자(1900)와 앞자리 0이 있는 문자열("0900")이 섞여 오고, 앞자리 0이 빠진 숫자(900)도 올 수 있어 4자리로 맞춘다
const pad4 = (v) => {
  const s = String(v ?? "").trim();
  return /^\d{3}$/.test(s) ? `0${s}` : s;
};

/** 목록 응답 한 줄의 요일별 시각을 8칸("HHmm-HHmm" 또는 null, 월~일·공휴일)으로. */
export function hoursOfRaw(raw) {
  const r = {};
  for (let i = 1; i <= 8; i++) {
    r[`dutyTime${i}s`] = pad4(raw[`dutyTime${i}s`]);
    r[`dutyTime${i}c`] = pad4(raw[`dutyTime${i}c`]);
  }
  return hoursOf(r);
}

/** 종료 시각("HHmm-HHmm")을 숫자로. 종료가 시작보다 이르거나 같으면(예: 0000, 0200) 자정을 넘긴 것으로 보고 2400을 더한다. */
function closeOf(slot) {
  const [open, close] = slot.split("-").map(Number);
  return close <= open ? close + 2400 : close;
}

/**
 * 요일별 8칸(월~일·공휴일)을 분류한다. "18시 이후"는 종료 시각이 18:00보다 늦은 것(18:00 정각은 아니다).
 * weekend 는 토·일 중 하루라도 시간이 있는 것, holiday 는 공휴일 칸에 시간이 있는 것, maxClose 는 평일(월~금) 종료 시각의 최댓값(없으면 0).
 */
export function classifyHours(hours) {
  const weekday = hours.slice(0, 5).filter(Boolean).map(closeOf);
  return {
    weekdayAfter18: weekday.some((c) => c > 1800),
    weekdayAfter22: weekday.some((c) => c >= 2200),
    weekend: Boolean(hours[5] || hours[6]),
    holiday: Boolean(hours[7]),
    maxClose: Math.max(0, ...weekday),
  };
}

/** 약국 한 곳의 식별자: 기관ID, 없으면 이름+주소. */
export function pharmacyKey(raw) {
  const id = String(raw.hpid ?? "").trim();
  if (id) return id;
  const name = String(raw.dutyName ?? "").trim(), addr = String(raw.dutyAddr ?? "").trim();
  return name && addr ? `${name}|${addr}` : null;
}

const FLAGS = ["weekdayAfter18", "weekdayAfter22", "weekend", "holiday"];

/** 병원 하나를 그 반경 안에서 가장 늦게 끝나는 약국의 평일 종료 시각으로 나눈다. */
function bucketOf(pharmacies) {
  if (pharmacies.length === 0) return "none";
  const best = Math.max(...pharmacies.map((p) => p.c.maxClose));
  if (best <= 1800) return "noLate";
  if (best < 2000) return "b18to20";
  if (best < 2200) return "b20to22";
  return "b22plus";
}

/**
 * rows: [{ name, pharmacies: [{ meters, c }] }] (c 는 classifyHours 결과). radii(m)마다
 *  - byRadius: 그 반경 안에 조건에 맞는 약국이 하나라도 있는 병원 수
 *  - closeBuckets: 병원 수를 "가장 늦게 끝나는 약국의 평일 종료 시각"(없음·18시 이전·18~20시·20~22시·22시 이상)으로 나눈 것
 */
export function summarize(rows, radii) {
  const byRadius = {}, closeBuckets = {};
  for (const r of radii) {
    const near = rows.map((row) => row.pharmacies.filter((p) => p.meters <= r));
    const stat = { anyPharmacy: near.filter((l) => l.length > 0).length };
    for (const f of FLAGS) stat[f] = near.filter((l) => l.some((p) => p.c[f])).length;
    byRadius[r] = stat;
    const b = { none: 0, noLate: 0, b18to20: 0, b20to22: 0, b22plus: 0 };
    for (const l of near) b[bucketOf(l)]++;
    closeBuckets[r] = b;
  }
  const within = (row, r, f) => row.pharmacies.filter((p) => p.meters <= r && p.c[f]).length;
  const after18CountsWithin1000 = rows.map((row) => within(row, 1000, "weekdayAfter18"));       // 병원 순서대로(이름이 같은 병원도 따로)
  return {
    hospitals: rows.length,
    byRadius,
    closeBuckets,
    noWeekdayAfter18Within1000: rows.filter((row) => within(row, 1000, "weekdayAfter18") === 0).map((row) => row.name),
    after18CountsWithin1000,
  };
}

const DIST_BUCKETS = [["0곳", (n) => n === 0], ["1~4곳", (n) => n >= 1 && n <= 4], ["5~9곳", (n) => n >= 5 && n <= 9], ["10~19곳", (n) => n >= 10 && n <= 19], ["20곳 이상", (n) => n >= 20]];

/** 병원별 약국 수 목록을 구간으로 나누고 최댓값·중앙값(정렬 뒤 가운데, 짝수 개면 위쪽)을 구한다. */
export function countDistribution(counts) {
  const buckets = Object.fromEntries(DIST_BUCKETS.map(([label]) => [label, 0]));
  for (const n of counts) buckets[DIST_BUCKETS.find(([, test]) => test(n))[0]]++;
  const sorted = [...counts].sort((a, b) => a - b);
  return { buckets, max: sorted.length ? sorted[sorted.length - 1] : 0, median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0 };
}

/**
 * 병원 전체 기준으로 반경(m) 안 약국을 **중복 없이** 센다(여러 병원 근처에서 겹치는 약국은 한 번만).
 * rows: [{ pharmacies: [{ key, meters, c }] }]. 종료 시각은 평일(월~금) 기준: after18 = 18시 넘어서까지, after20 = 20시 이후까지, after22 = 22시 이후까지, midnight = 24시(자정)까지.
 */
export function uniqueNearby(rows, radii) {
  const out = {};
  for (const r of radii) {
    const seen = new Map();
    for (const row of rows) for (const p of row.pharmacies) if (p.meters <= r && !seen.has(p.key)) seen.set(p.key, p.c);
    const cs = [...seen.values()];
    out[r] = {
      all: cs.length,
      after18: cs.filter((c) => c.weekdayAfter18).length,
      after20: cs.filter((c) => c.maxClose >= 2000).length,
      after22: cs.filter((c) => c.weekdayAfter22).length,
      midnight: cs.filter((c) => c.maxClose >= 2400).length,
      weekend: cs.filter((c) => c.weekend).length,
      holiday: cs.filter((c) => c.holiday).length,
    };
  }
  return out;
}

/** 좌표 기준 반경(m) 안에서 가장 가까운 달빛병원 {id, name, meters(반올림)}, 없으면 null. 좌표 없는 병원은 무시한다. */
export function nearestHospital(lat, lng, hospitals, maxMeters) {
  let best = null;
  for (const h of hospitals) {
    if (h.lat == null || h.lng == null) continue;
    const m = distanceMeters(lat, lng, h.lat, h.lng);
    if (m <= maxMeters && (!best || m < best.m)) best = { id: h.id, name: h.name, m };
  }
  return best && { id: best.id, name: best.name, meters: Math.round(best.m) };
}

/** 약국 목록 응답 한 줄 → 앱 모양. 기관ID·이름·주소·시도를 알 수 없으면 null(건너뛴다). 휴대전화(010 등)는 개인 번호일 수 있어 뺀다. */
export function pharmacyItem(raw, near) {
  const id = String(raw.hpid ?? "").trim();
  const name = stripHtml(raw.dutyName ?? "").trim();
  const address = String(raw.dutyAddr ?? "").replace(/\s+/g, " ").trim();
  const sido = sidoOf(address);
  if (!id || !name || !address || !sido) return null;
  const tel = stripHtml(raw.dutyTel1 ?? "").trim();
  const m = address.match(/^\S+\s+(\S+)/);
  return {
    id, name, address, sido,
    district: m ? m[1] : null,
    lat: Number(raw.wgs84Lat), lng: Number(raw.wgs84Lon),
    tel: tel && !tel.replace(/\D/g, "").startsWith("01") ? tel : null,
    hours: hoursOfRaw(raw),
    near,
  };
}
