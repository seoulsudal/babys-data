// 수집 워크플로가 제때 성공하고 있는지 점검한다.
// GitHub 은 예약 실행이 실패하면 메일을 보내지만, 예약 실행이 조용히 멈추거나(워크플로가 꺼짐·실행 누락) 오래 실패하는 것은 따로 알려 주지 않는다.
// 이 점검이 그 틈을 메운다: 워크플로 상태와 최근 실행 기록만 읽고, 문제가 있으면 보고서(마크다운)를 만든다.
// 사용자 데이터·인증키는 다루지 않는다(GitHub API 읽기 전용).

const DAY = 86_400_000;
const FAILURES = new Set(["failure", "timed_out", "startup_failure"]);

/** 점검 대상. maxAgeDays: 마지막 성공이 이보다 오래되면 문제, maxConsecutiveFailures: 연속 실패가 이 횟수에 닿으면 문제. */
export const RULES = [
  { file: "update-outing.yml", label: "나들이 수집(매일)", maxAgeDays: 3, maxConsecutiveFailures: 2 },
  { file: "update-moonlight.yml", label: "달빛병원 수집(매일)", maxAgeDays: 3, maxConsecutiveFailures: 2 },
  { file: "update-pharmacy.yml", label: "약국 수집(매일)", maxAgeDays: 3, maxConsecutiveFailures: 2 },
  { file: "update-places.yml", label: "키즈카페 수집(월 1회)", maxAgeDays: 40, maxConsecutiveFailures: 1 },
  { file: "check-vcninfo.yml", label: "예방접종 API 점검(주 1회)", maxAgeDays: 10, maxConsecutiveFailures: 2 },
];

/**
 * 한 워크플로를 판단한다. runs 는 GitHub 의 실행 기록(순서가 섞여도 된다), now 는 기준 시각.
 * 취소·건너뜀·진행 중인 실행은 성공도 실패도 아니라 무시한다.
 */
export function assess(rule, workflow, runs, now) {
  const problems = [];
  if (!workflow) problems.push("워크플로를 찾을 수 없어요.");
  else if (workflow.state !== "active") problems.push(`워크플로가 꺼져 있어요(${workflow.state}).`);

  const done = runs
    .filter((r) => r.conclusion === "success" || FAILURES.has(r.conclusion))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const lastSuccess = done.find((r) => r.conclusion === "success") ?? null;
  let consecutiveFailures = 0;
  for (const r of done) {
    if (r.conclusion === "success") break;
    consecutiveFailures++;
  }

  let ageDays = null;
  if (!lastSuccess) {
    problems.push(`성공한 실행 기록이 없어요(최근 ${done.length}건 중).`);
  } else {
    const age = now.getTime() - new Date(lastSuccess.created_at).getTime();
    ageDays = Math.floor(age / DAY);
    if (age > rule.maxAgeDays * DAY) problems.push(`마지막 성공이 ${ageDays}일 전이에요(기준 ${rule.maxAgeDays}일).`);
  }
  if (consecutiveFailures >= rule.maxConsecutiveFailures) problems.push(`연속 ${consecutiveFailures}번 실패했어요.`);

  return {
    ok: problems.length === 0,
    problems,
    state: workflow?.state ?? null,
    lastSuccessAt: lastSuccess?.created_at ?? null,
    ageDays,
    consecutiveFailures,
  };
}

export const hasProblem = (results) => results.some((r) => !r.ok);

const kstDate = (now) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

/** 이슈 본문으로 쓸 보고서. results 의 각 항목은 { rule, ...assess 결과 }. */
export function buildReport(results, now) {
  const rows = results.map((r) => {
    const last = r.ageDays === null ? "없음" : r.ageDays === 0 ? "오늘" : `${r.ageDays}일 전`;
    return `| ${r.rule.label} | ${last} | ${r.consecutiveFailures}번 | ${r.ok ? "정상" : "⚠ 확인 필요"} |`;
  });
  const table = ["| 수집 | 마지막 성공 | 연속 실패 | 판정 |", "|---|---|---|---|", ...rows].join("\n");
  const head = `# 수집 점검 (${kstDate(now)})`;
  if (!hasProblem(results)) return `${head}\n\n모두 정상이에요.\n\n${table}\n`;
  const problems = results.filter((r) => !r.ok).map((r) => `- **${r.rule.label}** (\`${r.rule.file}\`): ${r.problems.join(" ")}`);
  return [
    head,
    "",
    table,
    "",
    "## 문제",
    ...problems,
    "",
    "## 할 일",
    "1. 저장소의 **Actions 탭**에서 위 워크플로의 최근 실행을 열어 실패한 단계의 로그를 확인하세요.",
    "2. 인증키(공공데이터포털 `DATA_GO_KR_API_KEY`, 서울 열린데이터광장 `SEOUL_API_KEY`)가 만료됐거나 활용신청 승인이 바뀌었는지, 출처 서버가 점검 중인지 살펴보세요.",
    "3. 워크플로가 꺼져 있다면 Actions 탭에서 다시 켜고(Enable workflow) **Run workflow**로 한 번 실행해 보세요.",
    "4. 원인을 고치면 다음 점검에서 이 이슈가 자동으로 닫혀요. 그동안 앱은 지금 게시된 자료로 계속 동작해요(자료 기준일이 오래될 뿐이에요).",
    "",
  ].join("\n");
}

/** GitHub API(읽기 전용)로 규칙마다 워크플로 상태와 최근 실행을 읽어 판단한다. API 오류는 예외로 던진다(점검 자체가 실패한 것). */
export async function collect({ fetchImpl = fetch, repo, token, rules = RULES, now = new Date() }) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "babys-data-watch" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const get = async (file, suffix = "") => {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/${file}${suffix}`, { headers });
    if (res.status === 404 && suffix === "") return null;      // 워크플로 파일이 없어졌다 → 문제로 알린다
    if (!res.ok) throw new Error(`${file}: GitHub API 응답 ${res.status}`);
    return res.json();
  };
  const results = [];
  for (const rule of rules) {
    const workflow = await get(rule.file);
    const runs = workflow ? ((await get(rule.file, "/runs?per_page=10&status=completed")).workflow_runs ?? []) : [];
    results.push({ rule, ...assess(rule, workflow, runs, now) });
  }
  return results;
}
