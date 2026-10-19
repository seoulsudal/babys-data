// 국립중앙의료원 「전국 약국 정보 조회 서비스」 호출(약국 탐색·약국 수집이 함께 쓴다).
import { parseApiBody } from "./moonlight-lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 호출 상한(maxCalls)을 지키는 클라이언트. 인증키는 이미 URL 인코딩된 값(Encoding 키)이어도 이중 인코딩되지 않게 푼다. */
export function createApi({ base, key, maxCalls }) {
  const apiKey = key.includes("%") ? decodeURIComponent(key) : key;
  let calls = 0;
  return {
    get calls() { return calls; },
    async call(op, params) {
      if (calls >= maxCalls) throw new Error("호출 상한 도달");
      calls++;
      const url = new URL(`${base}/${op}`);
      url.search = new URLSearchParams({ serviceKey: apiKey, _type: "json", ...params }).toString();
      const res = await fetch(url);
      const text = await res.text();
      try {
        return parseApiBody(text);
      } catch (e) {
        throw new Error(`${op}: ${e.message} (HTTP ${res.status})`);      // 요청 주소·본문(키가 들어갈 수 있음)은 출력하지 않는다
      }
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
