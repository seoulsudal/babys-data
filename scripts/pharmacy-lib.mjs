// 달빛병원 근처 약국 분류용 순수 함수(국립중앙의료원 「전국 약국 정보 조회 서비스」 응답 → 분류).
export { hoursOf as hoursOfRaw } from "./moonlight-lib.mjs";

const EARTH_M = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

/** 두 좌표 사이의 직선거리(m). */
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(a));
}

/** 종료 시각("HHmm")을 숫자로. 종료가 시작보다 이르거나 같으면(예: 0000, 0200) 자정을 넘긴 것으로 보고 2400을 더한다. */
function closeOf(slot) {
  const [open, close] = slot.split("-").map(Number);
  return close <= open ? close + 2400 : close;
}

/**
 * 요일별 8칸(월~일·공휴일)을 분류한다. "18시 이후"는 종료 시각이 18:00보다 늦은 것(18:00 정각은 아니다).
 * weekend 는 토·일 중 하루라도 시간이 있는 것, holiday 는 공휴일 칸에 시간이 있는 것.
 */
export function classifyHours(hours) {
  const weekday = hours.slice(0, 5).filter(Boolean).map(closeOf);
  return {
    weekdayAfter18: weekday.some((c) => c > 1800),
    weekdayAfter22: weekday.some((c) => c >= 2200),
    weekend: Boolean(hours[5] || hours[6]),
    holiday: Boolean(hours[7]),
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

/**
 * rows: [{ name, pharmacies: [{ meters, c }] }] (c 는 classifyHours 결과). radii(m)마다 "그 반경 안에 조건에 맞는 약국이 하나라도 있는 병원 수"를 센다.
 */
export function summarize(rows, radii) {
  const byRadius = {};
  for (const r of radii) {
    const near = rows.map((row) => row.pharmacies.filter((p) => p.meters <= r));
    const stat = { anyPharmacy: near.filter((l) => l.length > 0).length };
    for (const f of FLAGS) stat[f] = near.filter((l) => l.some((p) => p.c[f])).length;
    byRadius[r] = stat;
  }
  const within = (row, r, f) => row.pharmacies.filter((p) => p.meters <= r && p.c[f]).length;
  const perHospitalAfter18Within1000 = Object.fromEntries(rows.map((row) => [row.name, within(row, 1000, "weekdayAfter18")]));
  return {
    hospitals: rows.length,
    byRadius,
    noWeekdayAfter18Within1000: rows.filter((row) => within(row, 1000, "weekdayAfter18") === 0).map((row) => row.name),
    perHospitalAfter18Within1000,
  };
}
