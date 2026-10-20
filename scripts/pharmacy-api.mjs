// 국립중앙의료원 「전국 약국 정보 조회 서비스」 호출(약국 탐색·약국 수집이 함께 쓴다).
import { parseApiBody } from "./moonlight-lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ATTEMPTS = 4;                    // 연결이 끊기거나 서버가 바쁠 때 한 호출을 최대 이만큼 시도한다
const TIMEOUT_MS = 30000;
const RETRY_PAUSE_MS = Number(process.env.PHARMACY_RETRY_PAUSE_MS || 1000);     // 첫 재시도 전 대기(이후 두 배씩)

/** API 가 준 오류 응답(인증키·호출 한도·구조 오류 등) — 다시 시도해도 같으므로 재시도하지 않는다. */
class ApiError extends Error {}

/** 연결 오류에서 원인(예: ECONNRESET)만 뽑는다. 요청 주소·본문은 키가 들어갈 수 있어 담지 않는다. */
function describe(e) {
  const cause = e?.cause?.code || e?.cause?.message || "";
  return `${e?.name ?? "Error"}: ${e?.message ?? e}${cause ? ` (${String(cause).slice(0, 80)})` : ""}`;
}

/** 호출 상한(maxCalls)을 지키는 클라이언트. 인증키는 이미 URL 인코딩된 값(Encoding 키)이어도 이중 인코딩되지 않게 푼다. */
export function createApi({ base, key, maxCalls }) {
  const apiKey = key.includes("%") ? decodeURIComponent(key) : key;
  let calls = 0;
  return {
    get calls() { return calls; },
    async call(op, params) {
      const url = new URL(`${base}/${op}`);
      url.search = new URLSearchParams({ serviceKey: apiKey, _type: "json", ...params }).toString();
      let last;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        if (calls >= maxCalls) throw new Error("호출 상한 도달");
        calls++;
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
          const text = await res.text();
          if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);        // 서버가 바쁘다 → 재시도
          try {
            return parseApiBody(text);
          } catch (e) {
            throw new ApiError(`${op}: ${e.message} (HTTP ${res.status})`);
          }
        } catch (e) {
          if (e instanceof ApiError) throw e;
          last = e;                                              // 연결 끊김·시간 초과·5xx 는 잠시 뒤 다시 시도한다
          if (attempt < ATTEMPTS) await sleep(RETRY_PAUSE_MS * 2 ** (attempt - 1));
        }
      }
      throw new Error(`${op}: 네트워크 오류 ${describe(last)} (${ATTEMPTS}회 시도)`);
    },
  };
}

/** 약국 목록(getParmacyListInfoInqire)을 끝까지 넘기며 모두 읽는다. */
export async function listAllPharmacies(api, pageSize, { maxPages = 400, pauseMs = 100 } = {}) {
  const items = [];
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    const r = await api.call("getParmacyListInfoInqire", { pageNo: String(page), numOfRows: String(pageSize) });
    total = r.total;
    items.push(...r.items);
    if (page * pageSize >= r.total || r.items.length === 0) break;
    await sleep(pauseMs);
  }
  return { items, total };
}
