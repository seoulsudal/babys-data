// 달빛어린이병원 수집용 순수 함수(국립중앙의료원 「전국 병·의원 찾기 서비스」 getBabyListInfoInqire 응답 → 앱 모양).
import { stripHtml, pickLatLng } from "./outing-lib.mjs";

/* ---------------- 응답 읽기 ---------------- */

const XML_ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const unescapeXml = (s) => s.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]);
const cdataOrText = (s) => {
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return m ? m[1] : unescapeXml(s);
};
const tagText = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? cdataOrText(m[1]).trim() : null;
};

/**
 * API 응답(XML 또는 JSON)을 { code, total, items:[평평한 객체] } 로 읽는다.
 * 게이트웨이 오류(인증키 미등록·한도 초과 등)는 코드와 사유만 담아 던진다(응답 본문 전체·요청 주소는 내지 않는다 — 키가 들어갈 수 있다).
 */
export function parseApiBody(text) {
  const t = String(text).trim();
  if (t.startsWith("{")) return parseJson(JSON.parse(t));
  if (t.includes("<cmmMsgHeader>")) {
    throw new Error(`API 오류 ${tagText(t, "returnReasonCode") ?? "?"} ${tagText(t, "returnAuthMsg") ?? tagText(t, "errMsg") ?? ""}`.trim());
  }
  if (!t.includes("<response>") && !t.includes("<response ")) throw new Error("API 응답 형식이 아니다");
  const code = tagText(t, "resultCode");
  if (code && code !== "00") throw new Error(`API 오류 ${code} ${tagText(t, "resultMsg") ?? ""}`.trim());
  const items = [...t.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const o = {};
    for (const f of m[1].matchAll(/<([A-Za-z0-9_]+)>([\s\S]*?)<\/\1>/g)) o[f[1]] = cdataOrText(f[2]).trim();
    return o;
  });
  return { code: code ?? "00", total: Number(tagText(t, "totalCount") ?? items.length), items };
}

function parseJson(j) {
  // 게이트웨이 오류는 response 없이 코드·메시지만 오기도 한다(호출 한도 초과 등) — 빈 목록으로 읽지 않고 오류로 알린다
  if (!j?.response) {
    const gw = j?.cmmMsgHeader;
    if (gw) throw new Error(`API 오류 ${gw.returnReasonCode ?? "?"} ${gw.returnAuthMsg ?? gw.errMsg ?? ""}`.trim());
    if (j?.resultCode !== undefined) throw new Error(`API 오류 ${j.resultCode} ${j.resultMsg ?? ""}`.trim());
    throw new Error(`API 응답 구조가 다르다(최상위 키: ${Object.keys(j ?? {}).join(", ") || "없음"})`);
  }
  const header = j.response.header, body = j.response.body ?? {};
  const code = header?.resultCode ?? "00";
  if (code !== "00") throw new Error(`API 오류 ${code} ${header?.resultMsg ?? ""}`.trim());
  const raw = body.items?.item ?? [];
  const items = (Array.isArray(raw) ? raw : [raw]).filter(Boolean);
  return { code, total: Number(body.totalCount ?? items.length), items };
}

/* ---------------- 항목 변환 ---------------- */

const SIDO = [
  ["서울", /^서울/], ["부산", /^부산/], ["대구", /^대구/], ["인천", /^인천/], ["광주", /^광주/], ["대전", /^대전/], ["울산", /^울산/],
  ["세종", /^세종/], ["경기", /^경기/], ["강원", /^강원/], ["충북", /^충청북|^충북/], ["충남", /^충청남|^충남/],
  ["전북", /^전북|^전라북/], ["전남", /^전남|^전라남/], ["경북", /^경상북|^경북/], ["경남", /^경상남|^경남/], ["제주", /^제주/],
];

/** 주소 앞의 시도 이름을 "서울"·"경기"처럼 짧게. 모르면 null. */
export function sidoOf(address) {
  const first = String(address || "").trim().split(/\s+/)[0] || "";
  return SIDO.find(([, re]) => re.test(first))?.[0] ?? null;
}

const DAY_COUNT = 8;       // 월(1)~일(7), 공휴일(8)
const HHMM = /^\d{4}$/;
const clean = (v, max) => {
  const s = stripHtml(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

/** API 가 숫자로 주는 시각("900")은 앞자리 0 이 빠지므로 4자리로 맞춘다. */
const hhmm = (v) => {
  const s = String(v ?? "").trim();
  return /^\d{1,3}$/.test(s) ? s.padStart(4, "0") : s;
};

export function hoursOf(raw) {
  return Array.from({ length: DAY_COUNT }, (_, i) => {
    const open = hhmm(raw[`dutyTime${i + 1}s`]), close = hhmm(raw[`dutyTime${i + 1}c`]);
    return HHMM.test(open) && HHMM.test(close) ? `${open}-${close}` : null;
  });
}

/** 응답 한 줄 → 앱 모양. 기관ID·이름·주소가 없으면 null(건너뛴다). [generalHours] 는 병원 기본정보에서 읽은 일반 진료시간(8칸). */
export function hospitalItem(raw, generalHours = Array(DAY_COUNT).fill(null)) {
  const id = clean(raw.hpid, 40), name = clean(raw.dutyName, 100), address = clean(raw.dutyAddr, 200);
  if (!id || !name || !address) return null;
  const { lat, lng } = pickLatLng(raw.wgs84Lat, raw.wgs84Lon);
  const m = address.match(/^\S+\s+(\S+)/);
  return {
    id, name,
    kind: clean(raw.dutyDivNam, 30),
    address,
    sido: sidoOf(address),
    district: m ? m[1] : null,
    lat, lng,
    tel: clean(raw.dutyTel1, 30),
    note: clean(raw.dutyEtc, 300),
    info: clean(raw.dutyInf, 300),
    hours: hoursOf(raw),
    generalHours,
  };
}
