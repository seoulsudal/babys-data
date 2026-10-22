// 병원 일반 진료시간 탐색 스크립트의 흐름을 가짜 API 서버(127.0.0.1)로 검증한다 — 인증키·네트워크 없이, 임시 폴더에서. 병원·시간은 가상 값이다.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "probe-hospital-hours.mjs");
const night = ["1800", "2300"];

function fakeServer() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    calls.push(url.searchParams.get("HPID"));
    res.setHeader("content-type", "application/xml");
    const body = url.searchParams.get("HPID") === "A1"
      ? "<item><hpid>A1</hpid><dutyName>가나 병원</dutyName><dutyTime1s>0900</dutyTime1s><dutyTime1c>1800</dutyTime1c></item>"
      : "<item><hpid>A2</hpid><dutyName>다라 의원</dutyName></item>";
    res.end(`<response><header><resultCode>00</resultCode></header><body><items>${body}</items><totalCount>1</totalCount></body></response>`);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, calls, port: server.address().port })));
}

test("병원마다 기본정보를 불러 진료시간이 있는 곳·달빛 운영시간과 다른 곳을 세고 보고서를 쓴다", async () => {
  const { server, calls, port } = await fakeServer();
  const root = await mkdtemp(join(tmpdir(), "hours-"));
  await mkdir(join(root, "docs"), { recursive: true });
  const dark = [`${night[0]}-${night[1]}`, null, null, null, null, null, null, null];
  await writeFile(join(root, "docs/moonlight.json"), JSON.stringify({ items: [{ id: "A1", hours: dark }, { id: "A2", hours: dark }] }));
  try {
    const out = await new Promise((ok) => {
      const c = spawn(process.execPath, [SCRIPT], { env: { ...process.env, MOONLIGHT_ROOT: root, DATA_GO_KR_API_KEY: "test-key-123", MOONLIGHT_API_BASE: `http://127.0.0.1:${port}`, HOURS_REPORT: "docs/h.txt" } });
      let t = ""; c.stdout.on("data", (d) => (t += d)); c.stderr.on("data", (d) => (t += d)); c.on("close", (code) => ok({ code, t }));
    });
    assert.equal(out.code, 0, out.t);
    assert.deepEqual(calls, ["A1", "A2"]);
    assert.match(out.t, /응답 2곳, 요일별 진료시간 있음 1곳, 달빛 운영시간과 다름 1곳/);
    assert.equal(out.t.includes("test-key-123"), false);
    assert.match(await readFile(join(root, "docs/h.txt"), "utf8"), /첫 응답 필드/);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test("인증키가 없으면 호출 없이 실패한다", async () => {
  const code = await new Promise((ok) => spawn(process.execPath, [SCRIPT], { env: { ...process.env, DATA_GO_KR_API_KEY: "" } }).on("close", ok));
  assert.notEqual(code, 0);
});
