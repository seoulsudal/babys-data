// 달빛어린이병원 수집 순수 함수 시험. 아래 병원·전화번호는 모두 검증용 가상 값이며 실제 병원이 아니다.
import test from "node:test";
import assert from "node:assert/strict";
import { parseApiBody, hospitalItem, sidoOf } from "./moonlight-lib.mjs";

const xml = (items, extra = "") => `<?xml version="1.0" encoding="UTF-8"?><response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header><body><items>${items}</items><numOfRows>10</numOfRows><pageNo>1</pageNo><totalCount>${extra || 2}</totalCount></body></response>`;

test("XML 응답: 항목을 평평한 객체로 읽고 CDATA·특수문자를 푼다", () => {
  const r = parseApiBody(xml(
    "<item><hpid>A1</hpid><dutyName><![CDATA[가나 아동병원]]></dutyName><dutyEtc>소아 &amp; 청소년</dutyEtc></item><item><hpid>A2</hpid><dutyName>다라의원</dutyName></item>",
  ));
  assert.equal(r.code, "00");
  assert.equal(r.total, 2);
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items[0], { hpid: "A1", dutyName: "가나 아동병원", dutyEtc: "소아 & 청소년" });
});

test("XML 응답: 항목이 하나여도, 하나도 없어도 배열로 돌려준다", () => {
  assert.equal(parseApiBody(xml("<item><hpid>A1</hpid></item>", 1)).items.length, 1);
  assert.deepEqual(parseApiBody(xml("", 0)).items, []);
  assert.deepEqual(parseApiBody(`<response><header><resultCode>00</resultCode></header><body><items/><totalCount>0</totalCount></body></response>`).items, []);
});

test("JSON 응답도 같은 모양으로 읽는다(항목이 하나면 객체로 온다)", () => {
  const one = parseApiBody(JSON.stringify({ response: { header: { resultCode: "00" }, body: { items: { item: { hpid: "A1" } }, totalCount: 1 } } }));
  assert.deepEqual(one.items, [{ hpid: "A1" }]);
  assert.equal(one.total, 1);
  const none = parseApiBody(JSON.stringify({ response: { header: { resultCode: "00" }, body: { items: "", totalCount: 0 } } }));
  assert.deepEqual(none.items, []);
});

test("게이트웨이 오류 응답은 오류 코드를 던진다(본문 전체는 담지 않는다)", () => {
  const bad = `<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnReasonCode>30</returnReasonCode><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>`;
  assert.throws(() => parseApiBody(bad), (e) => /30/.test(e.message) && /SERVICE_KEY_IS_NOT_REGISTERED_ERROR/.test(e.message));
  assert.throws(() => parseApiBody("<html>not api</html>"), /응답/);
});

test("시도 이름을 짧게 맞춘다", () => {
  assert.equal(sidoOf("서울특별시 가나구 시험로 1"), "서울");
  assert.equal(sidoOf("경기도 다라시 시험로 2"), "경기");
  assert.equal(sidoOf("전북특별자치도 마바시 시험로 3"), "전북");
  assert.equal(sidoOf("강원특별자치도 사아시 시험로 4"), "강원");
  assert.equal(sidoOf("제주특별자치도 자차시 시험로 5"), "제주");
  assert.equal(sidoOf("충청남도 카타시 시험로 6"), "충남");
  assert.equal(sidoOf("서울 가나구 시험로 1"), "서울");              // 이미 짧게 오는 경우
  assert.equal(sidoOf("알 수 없는 주소"), null);
});

const raw = {
  hpid: "A0000001", dutyName: " 가나 아동병원 ", dutyDivNam: "병원", dutyAddr: "서울특별시 가나구 시험로 1 (시험동)",
  dutyTel1: "02-111-2222", dutyTel3: "02-111-3333", dutyEtc: "야간 진료는 전화 확인", dutyInf: "소아 전문 <b>병원</b>",
  wgs84Lat: "37.5", wgs84Lon: "127.0",
  dutyTime1s: "0900", dutyTime1c: "2300", dutyTime2s: "0900", dutyTime2c: "2300", dutyTime7s: "1000", dutyTime7c: "2400", dutyTime8s: "0900", dutyTime8c: "1800",
};

test("항목 변환: 앱이 쓰는 필드만 만들고 진료시간은 월~일·공휴일 8칸으로 담는다", () => {
  const h = hospitalItem(raw);
  assert.deepEqual(h, {
    id: "A0000001", name: "가나 아동병원", kind: "병원", address: "서울특별시 가나구 시험로 1 (시험동)", sido: "서울", district: "가나구",
    lat: 37.5, lng: 127.0, tel: "02-111-2222", emergencyTel: "02-111-3333", note: "야간 진료는 전화 확인", info: "소아 전문 병원",
    hours: ["0900-2300", "0900-2300", null, null, null, null, "1000-2400", "0900-1800"],
  });
});

test("항목 변환: 한쪽 시각만 있거나 형식이 틀리면 그 날은 null, 좌표가 범위 밖이면 null", () => {
  const h = hospitalItem({ ...raw, dutyTime1c: "", dutyTime2s: "9시", wgs84Lat: "0", wgs84Lon: "0" });
  assert.equal(h.hours[0], null);
  assert.equal(h.hours[1], null);
  assert.equal(h.lat, null);
  assert.equal(h.lng, null);
});

test("항목 변환: 기관ID나 이름이 없으면 건너뛴다", () => {
  assert.equal(hospitalItem({ ...raw, hpid: "" }), null);
  assert.equal(hospitalItem({ ...raw, dutyName: "  " }), null);
  assert.equal(hospitalItem({ ...raw, dutyAddr: "" }), null);
});
