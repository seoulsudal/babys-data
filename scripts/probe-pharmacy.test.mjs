// 약국 탐색 스크립트의 흐름을 가짜 API 서버(127.0.0.1)로 검증한다 — 인증키·네트워크 없이, 임시 폴더에서.
// 아래 병원·약국·좌표는 모두 검증용 가상 값이다.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "probe-pharmacy.mjs");

const pharmacy = (id, name, lat, hours) => {
  const times = hours.map((h, i) => (h ? `<dutyTime${i + 1}s>${h.slice(0, 4)}</dutyTime${i + 1}s><dutyTime${i + 1}c>${h.slice(5)}</dutyTime${i + 1}c>` : "")).join("");
  return `<item><hpid>${id}</hpid><dutyName>${name}</dutyName><dutyAddr>서울 가나구 ${name}</dutyAddr>${times}<wgs84Lat>${lat}</wgs84Lat><wgs84Lon>127.0</wgs84Lon></item>`;
};
const night = ["0900-2300", "0900-2300", "0900-2300", "0900-2300", "0900-2300", "0900-1800", null, null];
const day = ["0900-1800", "0900-1800", "0900-1800", "0900-1800", "0900-1800", null, null, null];
// 병원A(37.5, 127.0): P1 은 약 100m(밤까지), P2 는 약 700m(18시에 종료), P5 는 약 200m(밤까지). 병원B(37.6, 127.0): 약국이 없다. P3 는 다른 도시라 어느 병원과도 멀다.
const LIST = [pharmacy("P1", "밤 약국", 37.5009, night), pharmacy("P2", "낮 약국", 37.5063, day), pharmacy("P3", "먼 약국", 35.1, night), pharmacy("P5", "또 밤 약국", 37.5018, night)];

// 위치 조회(비교용): 병원A 근처에서는 P1 하나만 돌려준다(지금 영업 중인 약국만 돌려주는 것처럼)
const near = (lat) => (Math.abs(lat - 37.5) < 0.01
  ? `<item><hpid>P1</hpid><dutyName>밤 약국</dutyName><dutyAddr>서울 가나구 밤 약국</dutyAddr><latitude>37.5009</latitude><longitude>127.0</longitude><distance>0.1</distance></item>`
  : "");

function fakeServer(mode = "ok") {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const op = url.pathname.split("/").pop();
    calls.push(op);
    res.setHeader("content-type", "application/xml");
    if (mode === "error") return res.end("<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnReasonCode>30</returnReasonCode><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>");
    const wrap = (items, total) => res.end(`<response><header><resultCode>00</resultCode></header><body><items>${items}</items><totalCount>${total}</totalCount></body></response>`);
    if (op === "getParmacyListInfoInqire") {
      const rows = Number(url.searchParams.get("numOfRows")), page = Number(url.searchParams.get("pageNo"));
      return wrap(LIST.slice((page - 1) * rows, page * rows).join(""), LIST.length);
    }
    if (op === "getParmacyLcinfoInqire") return wrap(near(Number(url.searchParams.get("WGS84_LAT"))), 1);
    res.statusCode = 404; res.end("not found");
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, calls, port: server.address().port })));
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pharmacy-"));
  await mkdir(join(root, "docs"), { recursive: true });
  const hospitals = [
    { id: "H1", name: "병원A", lat: 37.5, lng: 127.0 },
    { id: "H2", name: "병원B", lat: 37.6, lng: 127.0 },
    { id: "H3", name: "좌표없음", lat: null, lng: null },
  ];
  await writeFile(join(root, "docs/moonlight.json"), JSON.stringify({ updatedAt: "2026-10-19T00:00:00Z", items: hospitals }));
  return root;
}

function run(root, port, env = {}) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, PHARMACY_ROOT: root, DATA_GO_KR_API_KEY: "test-key-123", PHARMACY_API_BASE: `http://127.0.0.1:${port}`, PHARMACY_PAGE_SIZE: "1", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => ok({ code, out }));
  });
}

test("목록(쪽 넘김)의 좌표·시간표로 반경별 분류하고, 위치 조회와 비교하며, 보고서 파일을 쓴다", async () => {
  const { server, calls, port } = await fakeServer();
  const root = await setup();
  const report = join(root, "docs/pharmacy-probe.txt");
  try {
    const r = await run(root, port, { PHARMACY_REPORT: report });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /달빛병원 2곳\(좌표 있음\)/);                                       // 좌표 없는 병원은 뺀다
    assert.match(r.out, /목록 조회: 전체 4건 중 좌표·식별자가 있는 약국 4곳\(없는 약국 0곳\)/);
    assert.equal(calls.filter((c) => c === "getParmacyListInfoInqire").length, 4);       // 4건을 1건씩 → 4쪽
    assert.equal(calls.filter((c) => c === "getParmacyLcinfoInqire").length, 2);         // 비교용: 병원마다 한 번(병원이 5곳 이하라 모두)
    assert.match(r.out, /반경 500m: 약국이 있는 병원 1곳 \/ 평일 18시 이후 1곳 \/ 22시 이후 1곳 \/ 주말 1곳 \/ 공휴일 0곳 \(병원 2곳 중\)/);
    assert.match(r.out, /반경 1000m: 약국이 있는 병원 1곳 \/ 평일 18시 이후 1곳/);
    assert.match(r.out, /반경 500m 평일 종료 시각별 병원: 약국 없음 1곳 \/ 18시 이전 종료 0곳 \/ 18~20시 0곳 \/ 20~22시 0곳 \/ 22시 이상 1곳/);
    assert.match(r.out, /약국 수별 병원 분포: \{"0곳":1,"1~4곳":1,"5~9곳":0,"10~19곳":0,"20곳 이상":0\} \(최대 2곳, 중앙값 2곳\)/);   // 병원A 는 1km 안 18시 이후 약국 2곳(P1·P5), 병원B 는 0곳
    assert.match(r.out, /반경 500m 약국\(병원이 겹치는 곳은 한 번만\): 전체 2곳 \/ 평일 18시 이후까지 2곳 \/ 20시 이후까지 2곳 \/ 22시 이후까지 2곳 \/ 24시까지 0곳 \/ 주말 운영 2곳 \/ 공휴일 운영 0곳/);
    assert.match(r.out, /1km 안에 평일 18시 이후 약국이 없는 병원 1곳: 병원B/);
    assert.match(r.out, /비교\(병원A\): 목록 기준 1km 안 3곳 \/ 위치 조회 1km 안 1곳/);        // 위치 조회는 일부만 돌려준다
    assert.match(r.out, /위치 조회에 없는 약국 2곳 중 평일 22시 이전에 끝나는 약국 1곳/);
    assert.match(r.out, /첫 응답 필드: hpid, dutyName/);                                  // 실제 응답 모양을 확인할 수 있게 필드 이름을 출력한다
    assert.equal(r.out.includes("test-key-123"), false);
    const file = await readFile(report, "utf8");
    assert.match(file, /반경 500m: 약국이 있는 병원 1곳/);
    assert.equal(file.includes("test-key-123"), false);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test("인증키가 없으면 호출 없이 실패하고, 서비스 오류는 코드만 알리며 키를 출력하지 않는다", async () => {
  const { server, calls, port } = await fakeServer("error");
  const root = await setup();
  try {
    const none = await run(root, port, { DATA_GO_KR_API_KEY: "" });
    assert.notEqual(none.code, 0);
    assert.equal(calls.length, 0);
    const bad = await run(root, port);
    assert.notEqual(bad.code, 0);
    assert.match(bad.out, /30/);
    assert.equal(bad.out.includes("test-key-123"), false);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});
