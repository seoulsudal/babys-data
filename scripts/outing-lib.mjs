// 나들이(장소·행사) 수집의 순수 함수 모음. 네트워크·파일 입출력이 없어 단위 테스트로 검증한다(outing-lib.test.mjs).
// 사용자의 sub_project 수집 스크립트(scripts/fetch-data.mjs)에서 옮겨 오되, 앱이 쓰지 않는 값
// (이미지·연령·무료·실내 추정)은 만들지 않는다 — 글에서 추정한 값이라 틀릴 수 있기 때문이다.
import { createHash } from "node:crypto";

/* ---------------- 선택 기준 (키워드 기반. 바꾸면 테스트도 함께 고친다) ---------------- */

// 관광지 12, 문화시설 14, 레포츠 28 만 장소로 채택 (행사 15 는 따로, 숙박·음식·쇼핑 제외)
export const TOUR_PLACE_TYPES = new Set(["12", "14", "28"]);
// 장소는 목록 전체를 받지 않고 키워드로 먼저 좁혀 받는다 (searchKeyword2)
export const TOUR_PLACE_KEYWORDS = [
  "어린이", "키즈", "유아", "아이와", "가족", "동물원", "수족관", "아쿠아리움",
  "과학관", "테마파크", "놀이", "체험", "목장", "휴양림", "생태", "자연학습",
];
// 제목에 이 단어가 있으면 아이 동반 장소일 가능성이 높아 상세 조회를 먼저 한다
export const STRONG_KID_RE = /어린이|키즈|유아|아이|동물원|수족관|아쿠아|과학관|테마파크|놀이|체험|목장|농장/;
// 행사는 이 단어가 제목/이용대상/개요에 실제로 있어야 채택한다 ("누구나 관람"만으로는 채택하지 않음)
export const KID_EVENT_STRICT_RE = /어린이|영유아|유아|아기|아가|아이(?!돌|스|유|디|템|폰|콘)|키즈|가족|패밀리|동화|그림책|인형극|초등|유치원|꼬마|놀이|만들기/;
export const KID_EVENT_RE = /어린이|아이|유아|키즈|가족|체험|동화|놀이|그림책|인형극|동물|곤충|과학|만들기|캐릭터|축제|페스티벌/;
export const ONLINE_RE = /온라인|비대면/;
export const ADULT_ONLY_RE = /맥주|와인|막걸리|주류|위스키|클럽|EDM|19세/;
// 이용대상이 "성인"으로 시작하면 성인 전용으로 본다 ("어린이·성인 누구나" 같은 값은 제외하지 않는다)
export const ADULT_TARGET_RE = /^\s*(성인|만?\s*19세)/;

/* ---------------- 유틸 ---------------- */

export function stripHtml(v) {
  return String(v ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// homepage 필드는 <a href="..."> 형태의 HTML 로 오는 경우가 많다. http(s) 주소만 인정한다.
export function extractUrl(v) {
  const s = String(v ?? "");
  const m = s.match(/href=["']([^"']+)["']/i) || s.match(/https?:\/\/[^\s"'<>]+/i);
  if (!m) return null;
  const url = (m[1] || m[0]).trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

export const dashed = (s) => (s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);

export function shortHash(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 10);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

// 서울 API는 LAT/LOT 가 뒤바뀌어 오는 경우가 있어 값의 범위로 위도·경도를 판별한다
export function pickLatLng(a, b) {
  const x = num(a), y = num(b);
  if (x == null || y == null) return { lat: null, lng: null };
  const isLat = (v) => v >= 33 && v <= 39;
  const isLng = (v) => v >= 124 && v <= 132;
  if (isLat(x) && isLng(y)) return { lat: x, lng: y };
  if (isLat(y) && isLng(x)) return { lat: y, lng: x };
  return { lat: null, lng: null };
}

// 시군구명이 비어 있으면 주소 앞부분에서 뽑는다 (예: "경기 과천시 ..." → 과천시)
export function fillDistrict(item) {
  if (item.district) return item;
  const address = item.address || "";
  const m = address.match(/([가-힣]+[시군구])(?:\s|$)/g);
  const first = (address.split(/\s+/)[1] || "").match(/^[가-힣]+[시군구]$/);
  return { ...item, district: first ? first[0] : (m ? m[m.length - 1].trim() : null) };
}

// 같은 제목·시작일이면 하나로 합친다. 충돌 시 서울 자료를 우선한다.
export function dedupe(list) {
  const seen = new Map();
  for (const it of list) {
    const key = `${(it.title || "").replace(/\s+/g, "")}|${it.startDate || ""}`;
    if (!seen.has(key) || it.source === "seoul") seen.set(key, it);
  }
  return [...seen.values()];
}

export function applyOverrides(items, ov) {
  const exclude = new Set(ov.exclude || []);
  const out = items.filter((i) => !exclude.has(i.id)).map((i) => ({ ...i, ...(ov.patch?.[i.id] || {}) }));
  for (const add of ov.add || []) out.push({ source: "manual", ...add });
  return out;
}

/* ---------------- 한국관광공사 TourAPI ---------------- */

/** 행사 후보면 {start, end}, 아니면 null (기간이 아직 안 끝났고 window 안에 시작, 성인 전용 아님, 아이 단어가 제목에 있음). */
export function tourEventCandidate(raw, today, until) {
  const start = dashed(raw.eventstartdate);
  const end = dashed(raw.eventenddate) || start;
  if (!start || end < today || start > until) return null;
  const text = `${raw.title}`;
  if (ADULT_ONLY_RE.test(text) || !KID_EVENT_RE.test(text)) return null;
  return { start, end };
}

export function tourPlaceCandidate(raw) {
  return TOUR_PLACE_TYPES.has(raw.contenttypeid) && !ADULT_ONLY_RE.test(raw.title || "");
}

/** 상세(개요·홈페이지)까지 얻은 뒤에도 행사는 한 번 더 걸러 채택 여부를 정한다. */
export function tourEventReady(raw, detail) {
  return KID_EVENT_STRICT_RE.test(`${raw.title} ${detail.overview}`) && !ONLINE_RE.test(raw.title);
}

/** TourAPI 항목 → 앱 모양. 휴대전화 번호(010 등)는 개인 번호일 수 있어 뺀다. */
export function tourItem({ raw, kind, region, start, end }, detail) {
  const { lat, lng } = pickLatLng(raw.mapy, raw.mapx);
  const tel = stripHtml(raw.tel) || null;
  return {
    id: `tour-${raw.contentid}`,
    type: kind,
    title: stripHtml(raw.title),
    region,
    district: null,                       // 시군구명은 주소에서 추출(fillDistrict)
    address: stripHtml(`${raw.addr1 || ""} ${raw.addr2 || ""}`),
    lat, lng,
    ...(kind === "event" ? { startDate: start, endDate: end } : {}),
    officialUrl: detail.homepage || null,
    tel: tel && !tel.replace(/\D/g, "").startsWith("01") ? tel : null,
    source: "tour",
    summary: detail.overview || "",
  };
}

/* ---------------- 서울 열린데이터광장 ---------------- */

/** 서울 문화행사 한 줄 → 앱 모양. 조건에 안 맞으면 null. */
export function seoulEventItem(r, today, until) {
  const start = String(r.STRTDATE || "").slice(0, 10);
  const end = String(r.END_DATE || "").slice(0, 10) || start;
  if (!start || end < today || start > until) return null;
  const kidText = `${r.TITLE} ${r.USE_TRGT} ${r.CODENAME}`;
  if (ADULT_ONLY_RE.test(`${r.TITLE} ${r.CODENAME}`) || ADULT_TARGET_RE.test(r.USE_TRGT || "")) return null;
  if (ONLINE_RE.test(r.TITLE) || !KID_EVENT_STRICT_RE.test(kidText)) return null;
  const { lat, lng } = pickLatLng(r.LAT, r.LOT);
  return {
    id: `seoul-${shortHash(`${r.TITLE}|${start}|${r.PLACE}`)}`,
    type: "event",
    title: stripHtml(r.TITLE),
    region: "서울",
    district: r.GUNAME || null,
    address: stripHtml(r.PLACE),
    lat, lng,
    startDate: start, endDate: end,
    officialUrl: extractUrl(r.ORG_LINK) || extractUrl(r.HMPG_ADDR),
    tel: null,
    source: "seoul",
    summary: stripHtml(r.PROGRAM || r.ETC_DESC || "").slice(0, 300),
  };
}

/* ---------------- 출력 ---------------- */

const KEEP = ["id", "type", "title", "region", "district", "address", "lat", "lng", "startDate", "endDate", "officialUrl", "tel", "source", "summary"];

/** 앱이 쓰는 필드만 남긴다(이미지·연령·무료·실내는 담지 않는다). */
export function slimItem(item) {
  const out = {};
  for (const k of KEEP) if (item[k] !== undefined) out[k] = item[k];
  return out;
}

/** 목록 내용이 같은가(id 순서와 무관). updatedAt 은 비교하지 않는다. */
export function sameItems(a, b) {
  if (a.length !== b.length) return false;
  const byId = new Map(b.map((i) => [i.id, JSON.stringify(i)]));
  return a.every((i) => byId.get(i.id) === JSON.stringify(i));
}

/** 새 결과를 써도 되는가: 0건이면 안 되고, 지금 게시된 건수의 절반 미만이면 안 된다(수집이 일부만 된 경우). */
export function guardCount(existingCount, newCount) {
  return newCount > 0 && newCount * 2 >= existingCount;
}
