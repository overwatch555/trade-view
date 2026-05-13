const fs = require("fs");
const path = require("path");
const readline = require("readline");
const http = require("http");
const url = require("url");

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });

const RECORDS_CSV_PATH = path.join(DATA_DIR, "daily_records.csv");
const DASHBOARD_HTML_PATH = path.join(DATA_DIR, "dashboard.html");

function formatNumber(n, decimals = 2) {
  if (n === null || n === undefined || n === "") return "";
  const num = Number(n);
  if (Number.isNaN(num)) return String(n);
  return num.toFixed(decimals);
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const num = Number(v);
  return Number.isFinite(num) ? num : null;
}

function formatRange(min, max, decimals = 2) {
  if (min === null && max === null) return "";
  if (min === null) return formatNumber(max, decimals);
  if (max === null) return formatNumber(min, decimals);
  return `${formatNumber(min, decimals)}–${formatNumber(max, decimals)}`;
}

function defaultStopLossPct(input) {
  const v = toNumberOrNull(input);
  if (v === null) return -25;
  if (v > -20) return -20;
  if (v < -28) return -28;
  return v;
}

function computeDecisionTable(row) {
  if (!row) return { decisionHtml: "", logLine: "" };

  const totalFundsU = toNumberOrNull(row.total_funds_u);
  let riskMinU = toNumberOrNull(row.single_risk_min_u);
  let riskMaxU = toNumberOrNull(row.single_risk_max_u);
  let dailyMaxLossU = toNumberOrNull(row.daily_max_loss_u);
  let weeklyMaxDrawdownMinU = toNumberOrNull(row.weekly_max_drawdown_min_u);
  let weeklyMaxDrawdownMaxU = toNumberOrNull(row.weekly_max_drawdown_max_u);

  if (totalFundsU !== null && (riskMinU === null || riskMaxU === null || dailyMaxLossU === null)) {
    const risk = calcRisk(totalFundsU);
    if (riskMinU === null) riskMinU = toNumberOrNull(risk.singleRiskMinU);
    if (riskMaxU === null) riskMaxU = toNumberOrNull(risk.singleRiskMaxU);
    if (dailyMaxLossU === null) dailyMaxLossU = toNumberOrNull(risk.dailyMaxLossU);
    if (weeklyMaxDrawdownMinU === null) weeklyMaxDrawdownMinU = toNumberOrNull(risk.weeklyMaxDrawdownMinU);
    if (weeklyMaxDrawdownMaxU === null) weeklyMaxDrawdownMaxU = toNumberOrNull(risk.weeklyMaxDrawdownMaxU);
  }

  const slPct = defaultStopLossPct(row.stop_loss_pct);
  const slAbs = Math.abs(slPct / 100);

  let posConservative = riskMinU !== null ? riskMinU / slAbs : null;
  let posStandard = riskMaxU !== null ? riskMaxU / slAbs : null;
  let posAggressive = null;
  if (posStandard !== null) {
    posAggressive = posStandard * 1.5;
    if (dailyMaxLossU !== null) {
      const cap = (dailyMaxLossU * 0.5) / slAbs;
      posAggressive = Math.min(posAggressive, cap);
    }
  }

  // Enforce minimum position size of 5U
  if (posConservative !== null && posConservative < 5) posConservative = 5;
  if (posStandard !== null && posStandard < 5) posStandard = 5;
  if (posAggressive !== null && posAggressive < 5) posAggressive = 5;

  const emotionScore = toNumberOrNull(row.emotion_score);
  const emotionSuggestion = row.emotion_suggestion || "";
  const finalDecision = row.final_trade_decision || "";

  const breakEvenPlan =
    "+90%~+100% 卖 50%~60% 出本；剩余仓位移动止损；分批止盈（不要加仓摊平）";

  const suggestedPosition = [
    posConservative !== null ? `保守 <span class="crypto-equiv" data-u="${posConservative}">${formatNumber(posConservative, 2)}U</span>` : "",
    posStandard !== null ? `标准 <span class="crypto-equiv" data-u="${posStandard}">${formatNumber(posStandard, 2)}U</span>` : "",
    posAggressive !== null ? `进攻 <span class="crypto-equiv" data-u="${posAggressive}">${formatNumber(posAggressive, 2)}U</span>` : "",
  ]
    .filter(Boolean)
    .join("<br/>");

  const action =
    emotionScore !== null && emotionScore <= 6
      ? "禁止交易：关盘/限时看盘 + 做复盘或模拟盘"
      : finalDecision === "谨慎小仓"
        ? "谨慎小仓：只做A+机会；不加仓；严格止损"
        : finalDecision === "执行"
          ? "执行：按计划；触发止损直接退出；不追单"
          : "放弃：只复盘，不开仓";

  const stopLossDisplay = `${formatNumber(slPct, 0)}%`;

  const decisionHtml = `<div class="card" style="grid-column: 1 / -1;">
  <p class="title">可视化决策表（最新一条记录）</p>
  <p class="sub">按你的风控模板输出：资金 / 风险 / 仓位 / 止损 / 出本 / 决策</p>
  <div class="table-wrapper">
    <table>
      <thead>
        <tr>
          <th>项目</th>
          <th>数值</th>
          <th>说明</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>当前资金</td>
          <td>${escapeHtml(totalFundsU !== null ? `${formatNumber(totalFundsU, 2)}U` : "")}</td>
          <td>用于计算风险上限</td>
        </tr>
        <tr>
          <td>单笔风险</td>
          <td>${escapeHtml(
            riskMinU !== null || riskMaxU !== null ? `${formatRange(riskMinU, riskMaxU, 2)}U` : ""
          )}</td>
          <td>0.5%–0.6%</td>
        </tr>
        <tr>
          <td>单日最大亏损</td>
          <td>${escapeHtml(dailyMaxLossU !== null ? `${formatNumber(dailyMaxLossU, 2)}U` : "")}</td>
          <td>达到后停止交易</td>
        </tr>
        <tr>
          <td>单周最大回撤</td>
          <td>${escapeHtml(
            weeklyMaxDrawdownMinU !== null || weeklyMaxDrawdownMaxU !== null
              ? `${formatRange(weeklyMaxDrawdownMinU, weeklyMaxDrawdownMaxU, 2)}U`
              : ""
          )}</td>
          <td>超出说明策略/情绪失控</td>
        </tr>
        <tr>
          <td>建议仓位</td>
          <td>${suggestedPosition}</td>
          <td>按止损 ${escapeHtml(stopLossDisplay)} 反推最大持仓</td>
        </tr>
        <tr>
          <td>止损位</td>
          <td>${escapeHtml(stopLossDisplay)}</td>
          <td>默认 -25%，范围 -20% 到 -28%</td>
        </tr>
        <tr>
          <td>出本计划</td>
          <td>${escapeHtml(breakEvenPlan)}</td>
          <td>先活下来，再谈收益</td>
        </tr>
        <tr>
          <td>情绪分</td>
          <td>${escapeHtml(emotionScore !== null ? `${formatNumber(emotionScore, 0)}/10` : "")}</td>
          <td>${escapeHtml(emotionSuggestion)}</td>
        </tr>
        <tr>
          <td>最终决策</td>
          <td>${escapeHtml(finalDecision)}</td>
          <td>${escapeHtml(action)}</td>
        </tr>
      </tbody>
    </table>
  </div>
  <div class="row" style="margin-top: 10px;">
    <label>交易日志（复制用）</label>
    <textarea rows="2" readonly>${escapeHtml(
      [
        row.date || "",
        row.symbol || "",
        row.mc || "",
        row.notes || "",
        row.stop_loss_pct || stopLossDisplay,
        breakEvenPlan,
        row.suggested_position_u || "",
        row.emotion_score || "",
        finalDecision,
      ].join(" | ")
    )}</textarea>
  </div>
</div>`;

  const logLine = [
    row.date || "",
    row.symbol || "",
    row.mc || "",
    row.notes || "",
    row.stop_loss_pct || stopLossDisplay,
    breakEvenPlan,
    row.suggested_position_u || "",
    row.emotion_score || "",
    finalDecision,
  ].join(" | ");

  return { decisionHtml, logLine };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function todayISODate() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function calcRisk(totalFundsU) {
  const funds = Number(totalFundsU);
  if (!Number.isFinite(funds) || funds <= 0) {
    return {
      singleRiskMinU: "",
      singleRiskMaxU: "",
      dailyMaxLossU: "",
      weeklyMaxDrawdownMinU: "",
      weeklyMaxDrawdownMaxU: "",
    };
  }

  const singleRiskMinU = funds * 0.005;
  const singleRiskMaxU = funds * 0.006;
  const dailyMaxLossU = funds * 0.03;
  const weeklyMaxDrawdownMinU = funds * 0.08;
  const weeklyMaxDrawdownMaxU = funds * 0.1;

  return {
    singleRiskMinU,
    singleRiskMaxU,
    dailyMaxLossU,
    weeklyMaxDrawdownMinU,
    weeklyMaxDrawdownMaxU,
  };
}

function scoreEmotion({ mood, wantRecoverStrength, lossReaction, bodyState, expectation }) {
  let score = 10;

  const moodPenalty = {
    "平静": 0,
    "轻微焦虑": 1,
    "明显烦躁": 2,
    "非常冲动": 3,
    "绝望": 4,
  }[mood] ?? 0;
  score -= moodPenalty;

  const recoverPenalty = {
    "无": 0,
    "弱": 1,
    "中": 2,
    "强": 3,
  }[wantRecoverStrength] ?? 0;
  score -= recoverPenalty;

  const lossPenalty = {
    "A": 0,
    "B": 3,
    "C": 4,
  }[lossReaction] ?? 0;
  score -= lossPenalty;

  const bodyPenalty = {
    "正常": 0,
    "有点紧张": 1,
    "心跳明显加快": 2,
  }[bodyState] ?? 0;
  score -= bodyPenalty;

  const expectationPenalty = {
    "正常执行计划": 0,
    "想大赚一笔": 2,
    "必须翻红": 3,
  }[expectation] ?? 0;
  score -= expectationPenalty;

  score = clamp(score, 1, 10);

  let suggestion = "可以交易";
  if (score <= 6) suggestion = "禁止交易";
  else if (score <= 7) suggestion = "谨慎小仓";

  const revengeTradingRisk =
    wantRecoverStrength !== "无" ||
    lossReaction === "B" ||
    lossReaction === "C" ||
    expectation === "必须翻红";

  return { score, suggestion, revengeTradingRisk };
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function writeCsvRow(filePath, headers, row) {
  const exists = fs.existsSync(filePath);
  if (!exists) {
    fs.writeFileSync(filePath, `${headers.join(",")}\r\n`, "utf8");
  }
  const line = headers.map((h) => csvEscape(row[h] ?? "")).join(",") + "\r\n";
  fs.appendFileSync(filePath, line, "utf8");
}

function ensureCsvHeaders(filePath, desiredHeaders) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return;
  const existingHeaders = parseCsvLine(lines[0]);
  if (existingHeaders.join(",") === desiredHeaders.join(",")) return;

  const rows = readCsv(filePath);
  fs.writeFileSync(filePath, `${desiredHeaders.join(",")}\r\n`, "utf8");
  for (const row of rows) {
    const line = desiredHeaders.map((h) => csvEscape(row[h] ?? "")).join(",") + "\r\n";
    fs.appendFileSync(filePath, line, "utf8");
  }
}

function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

function parseCsvLine(line) {
  const out = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        const next = line[i + 1];
        if (next === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === ",") {
        out.push(current);
        current = "";
      } else if (ch === '"') {
        inQuotes = true;
      } else {
        current += ch;
      }
    }
  }
  out.push(current);
  return out;
}

function createReadline() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function askChoice(rl, question, choices, defaultValue) {
  const choiceText = choices.map((c) => c).join("/");
  const suffix = defaultValue ? `（${choiceText}，默认：${defaultValue}）` : `（${choiceText}）`;
  while (true) {
    const ans = await ask(rl, `${question}${suffix}：`);
    const picked = (ans || defaultValue || "").trim();
    if (choices.includes(picked)) return picked;
    process.stdout.write(`请输入以下之一：${choiceText}\n`);
  }
}

async function askYesNo(rl, question, defaultValue) {
  const choices = ["是", "否"];
  return askChoice(rl, question, choices, defaultValue);
}

function generateDashboardHtml(rows, options = {}) {
  const withForm = Boolean(options.withForm);
  const showCliHint = options.showCliHint !== false;
  const defaultFundsU = options.defaultFundsU ? String(options.defaultFundsU) : "";
  const latestRow = rows.length > 0 ? rows[rows.length - 1] : null;
  const { decisionHtml } = computeDecisionTable(latestRow);

  const dates = rows.map((r) => r.date);
  const emotionScores = rows.map((r) => Number(r.emotion_score || 0));
  const funds = rows.map((r) => Number(r.total_funds_u || 0));
  const realizedPnlU = rows.map((r) => {
    const v = Number(r.today_realized_pnl_u || 0);
    return Number.isFinite(v) ? v : 0;
  });
  const decisions = rows.map((r) => r.final_trade_decision || "");

  const decisionCounts = rows.reduce(
    (acc, r) => {
      const d = r.final_trade_decision || "未知";
      acc[d] = (acc[d] || 0) + 1;
      return acc;
    },
    {}
  );

  const decisionCountSeries = Object.keys(decisionCounts).map((k) => ({
    name: k,
    value: decisionCounts[k],
  }));

  const lastRows = rows.slice(-20).reverse();
  const tableHtml = lastRows
    .map((r) => {
      return `<tr>
  <td>${escapeHtml(r.date)}</td>
  <td>${escapeHtml(r.total_funds_u)}</td>
  <td>${escapeHtml(r.emotion_score)}</td>
  <td>${escapeHtml(r.emotion_suggestion)}</td>
  <td>${escapeHtml(r.want_recover_strength)}</td>
  <td>${escapeHtml(r.loss_reaction)}</td>
  <td>${escapeHtml(r.expectation)}</td>
  <td>${escapeHtml(r.today_trade_status)}</td>
  <td>${escapeHtml(r.today_realized_pnl_u)}</td>
  <td>${escapeHtml(r.today_trades_count)}</td>
  <td>${escapeHtml(r.final_trade_decision)}</td>
  <td>${escapeHtml(r.notes)}</td>
</tr>`;
    })
    .join("\n");

  const hasData = rows.length > 0;
  const emptyHint = hasData
    ? ""
    : `<div class="hint">
  目前没有数据。${showCliHint ? `先运行一次：<span class="mono">node trade-review.js checkin</span> 录入当日情况。` : "先在下方表单录入第一条记录。"}
</div>`;

  const formHtml = withForm
    ? `<div class="card" style="grid-column: 1 / -1;">
  <p class="title">今日打卡（页面填写）</p>
  <p class="sub">提交后会自动计算情绪分/风控并写入 CSV，然后刷新图表</p>
  <form id="checkinForm" class="form">
    <div class="row">
      <label>日期</label>
      <input name="date" type="date" value="${escapeHtml(todayISODate())}" required />
    </div>
    <div class="row">
      <label>当前总资金(U)</label>
      <input name="total_funds_u" inputmode="decimal" placeholder="50" value="${escapeHtml(defaultFundsU)}" />
    </div>

    <div class="row">
      <label>心情</label>
      <select name="mood">
        <option value="平静">平静</option>
        <option value="轻微焦虑" selected>轻微焦虑</option>
        <option value="明显烦躁">明显烦躁</option>
        <option value="非常冲动">非常冲动</option>
        <option value="绝望">绝望</option>
      </select>
    </div>

    <div class="row">
      <label>想回本强度</label>
      <select name="want_recover_strength">
        <option value="无">无</option>
        <option value="弱" selected>弱</option>
        <option value="中">中</option>
        <option value="强">强</option>
      </select>
    </div>

    <div class="row">
      <label>亏损反应</label>
      <select name="loss_reaction">
        <option value="A" selected>A：接受并执行止损</option>
        <option value="B">B：想加仓</option>
        <option value="C">C：非常难受/愤怒</option>
      </select>
    </div>

    <div class="row">
      <label>身体状态</label>
      <select name="body_state">
        <option value="正常" selected>正常</option>
        <option value="有点紧张">有点紧张</option>
        <option value="心跳明显加快">心跳明显加快</option>
      </select>
    </div>

    <div class="row">
      <label>期待（A/B/C）</label>
      <select name="expectation_code">
        <option value="A" selected>A：正常执行计划</option>
        <option value="B">B：想大赚一笔</option>
        <option value="C">C：必须翻红</option>
      </select>
    </div>

    <div class="row">
      <label>情绪稳定？</label>
      <select name="stable">
        <option value="是">是</option>
        <option value="否" selected>否</option>
      </select>
    </div>
    <div class="row">
      <label>FOMO？</label>
      <select name="fomo">
        <option value="是">是</option>
        <option value="否" selected>否</option>
      </select>
    </div>
    <div class="row">
      <label>能接受单日最大亏损后停手？</label>
      <select name="accept_daily_loss">
        <option value="是">是</option>
        <option value="否" selected>否</option>
      </select>
    </div>

    <div class="row">
      <label>今天实际交易</label>
      <select name="today_trade_status">
        <option value="未交易" selected>未交易</option>
        <option value="模拟">模拟</option>
        <option value="实盘">实盘</option>
      </select>
    </div>
    <div class="row">
      <label>已实现盈亏(U)</label>
      <input name="today_realized_pnl_u" inputmode="decimal" placeholder="-0.8 / 1.2" />
    </div>
    <div class="row">
      <label>交易笔数</label>
      <input name="today_trades_count" inputmode="numeric" placeholder="3" />
    </div>

    <details style="grid-column: 1 / -1;">
      <summary>可选：交易机会信息（用于复盘）</summary>
      <div class="detailGrid">
        <div class="row">
          <label>币种</label>
          <input name="symbol" placeholder="DOGE" />
        </div>
        <div class="row">
          <label>MC</label>
          <input name="mc" placeholder="50k / 1.2m" />
        </div>
        <div class="row">
          <label>流动性</label>
          <input name="liquidity" placeholder="简述" />
        </div>
        <div class="row">
          <label>预计持仓时间</label>
          <input name="holding_time" placeholder="15min / 2h" />
        </div>
        <div class="row">
          <label>最大止损%</label>
          <input name="stop_loss_pct" inputmode="decimal" placeholder="-25" />
        </div>
      </div>
    </details>

    <div class="row" style="grid-column: 1 / -1;">
      <label>备注</label>
      <textarea name="notes" rows="2" placeholder="可空"></textarea>
    </div>

    <div class="actions">
      <button type="submit">提交并刷新</button>
      <a class="link" href="/daily_records.csv" target="_blank" rel="noreferrer">下载CSV</a>
      <label class="link" style="cursor:pointer;">
        导入CSV
        <input type="file" id="importCsvInput" accept=".csv" style="display:none;" />
      </label>
    </div>
    <div id="formMsg" class="msg"></div>
  </form>
</div>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>交易复盘看板</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "PingFang SC", "Microsoft YaHei", sans-serif; margin: 10px; color: #111; font-size: 14px; background: #f1f5f9; }
      .grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
      @media (min-width: 960px) { body { margin: 20px; background: #fff; } .grid { grid-template-columns: 1fr 1fr; gap: 16px; } }
      .card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px; background: #fff; box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); }
      .title { font-size: 16px; font-weight: 700; margin: 0 0 4px 0; }
      @media (min-width: 960px) { .title { font-size: 18px; margin: 0 0 6px 0; } }
      .sub { margin: 0 0 10px 0; color: #555; font-size: 12px; }
      @media (min-width: 960px) { .sub { font-size: 13px; } }
      #chartEmotion, #chartDecision, #chartFunds, #chartPnl { width: 100%; height: 260px; }
      @media (min-width: 960px) { #chartEmotion, #chartDecision, #chartFunds, #chartPnl { height: 320px; } }
      .table-wrapper { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 -14px; padding: 0 14px; }
      @media (min-width: 960px) { .table-wrapper { margin: 0; padding: 0; } }
      table { width: 100%; border-collapse: collapse; font-size: 12px; white-space: nowrap; }
      th, td { border-bottom: 1px solid #eee; padding: 8px 6px; text-align: left; vertical-align: top; }
      th { background: #fafafa; }
      .hint { padding: 12px; border: 1px dashed #cbd5e1; border-radius: 10px; background: #f8fafc; margin-bottom: 12px; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
      .form { display: grid; grid-template-columns: 1fr; gap: 12px; }
      @media (min-width: 960px) { .form { grid-template-columns: 1fr 1fr 1fr; gap: 10px; } }
      .row { display: flex; flex-direction: column; gap: 6px; }
      @media (min-width: 960px) { .row { gap: 4px; } }
      .row label { font-size: 13px; color: #374151; font-weight: 500; }
      @media (min-width: 960px) { .row label { font-size: 12px; font-weight: normal; } }
      input, select, textarea { border: 1px solid #d1d5db; border-radius: 8px; padding: 10px 12px; font-size: 14px; width: 100%; box-sizing: border-box; background: #fff; appearance: none; }
      @media (min-width: 960px) { input, select, textarea { border: 1px solid #e5e7eb; padding: 8px 10px; font-size: 13px; appearance: auto; } }
      textarea { resize: vertical; }
      details { border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px; background: #f8fafc; }
      @media (min-width: 960px) { details { border: 1px dashed #cbd5e1; padding: 10px; } }
      summary { cursor: pointer; font-size: 14px; color: #111; font-weight: 500; outline: none; }
      @media (min-width: 960px) { summary { font-size: 13px; font-weight: normal; } }
      .detailGrid { display: grid; grid-template-columns: 1fr; gap: 12px; margin-top: 12px; }
      @media (min-width: 960px) { .detailGrid { grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-top: 10px; } }
      .actions { display: flex; gap: 12px; align-items: center; grid-column: 1 / -1; margin-top: 4px; }
      button { background: #111827; color: #fff; border: 0; border-radius: 10px; padding: 12px 16px; font-size: 14px; font-weight: 500; cursor: pointer; flex: 1; touch-action: manipulation; }
      @media (min-width: 960px) { button { padding: 10px 14px; font-size: 13px; font-weight: normal; flex: none; } }
      button:disabled { background: #94a3b8; cursor: not-allowed; }
      .link { color: #2563eb; font-size: 14px; text-decoration: none; text-align: center; }
      @media (min-width: 960px) { .link { font-size: 13px; text-align: left; } }
      .msg { grid-column: 1 / -1; font-size: 13px; color: #ef4444; }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
  </head>
  <body>
    <h1 style="margin:0 0 6px 0;">交易复盘看板</h1>
    <p class="sub">数据来源：${escapeHtml(RECORDS_CSV_PATH)}</p>
    ${emptyHint}
    <div class="grid">
      ${formHtml}
      ${decisionHtml}
      <div class="card">
        <p class="title">情绪分趋势</p>
        <p class="sub">1-10分；≤6 为禁止交易区间</p>
        <div id="chartEmotion"></div>
      </div>
      <div class="card">
        <p class="title">最终决策分布</p>
        <p class="sub">执行 / 放弃 / 谨慎小仓 / 禁止交易 等</p>
        <div id="chartDecision"></div>
      </div>
      <div class="card" style="grid-column: 1 / -1;">
        <p class="title">资金记录（如有填写）</p>
        <p class="sub">用于观察资金变化与情绪的相关性</p>
        <div id="chartFunds"></div>
      </div>
      <div class="card" style="grid-column: 1 / -1;">
        <p class="title">当日已实现盈亏（U）</p>
        <p class="sub">正数为盈利，负数为亏损；0 为未填/未交易</p>
        <div id="chartPnl"></div>
      </div>
      <div class="card" style="grid-column: 1 / -1;">
        <p class="title">最近20条记录</p>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>资金(U)</th>
                <th>情绪分</th>
                <th>情绪建议</th>
                <th>回本强度</th>
                <th>亏损反应</th>
                <th>期待</th>
                <th>实际交易</th>
                <th>已实现盈亏(U)</th>
                <th>交易笔数</th>
                <th>最终决策</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              ${tableHtml}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <script>
      const dates = ${JSON.stringify(dates)};
      const emotionScores = ${JSON.stringify(emotionScores)};
      const funds = ${JSON.stringify(funds)};
      const realizedPnlU = ${JSON.stringify(realizedPnlU)};
      const decisionCountSeries = ${JSON.stringify(decisionCountSeries)};

      const emotionChart = echarts.init(document.getElementById("chartEmotion"));
      emotionChart.setOption({
        grid: { left: 40, right: 20, top: 30, bottom: 40 },
        xAxis: { type: "category", data: dates, axisLabel: { rotate: 35 } },
        yAxis: { type: "value", min: 1, max: 10 },
        series: [{
          name: "情绪分",
          type: "line",
          data: emotionScores,
          smooth: true,
          symbolSize: 8,
          lineStyle: { width: 3 },
          markLine: {
            symbol: "none",
            lineStyle: { color: "#ef4444", type: "dashed" },
            data: [{ yAxis: 6, name: "≤6 禁止交易" }]
          }
        }],
        tooltip: { trigger: "axis" }
      });

      const decisionChart = echarts.init(document.getElementById("chartDecision"));
      decisionChart.setOption({
        tooltip: { trigger: "item" },
        series: [{
          name: "决策",
          type: "pie",
          radius: ["35%", "70%"],
          avoidLabelOverlap: true,
          label: { formatter: "{b}: {c} ({d}%)" },
          data: decisionCountSeries
        }]
      });

      const fundsChart = echarts.init(document.getElementById("chartFunds"));
      fundsChart.setOption({
        grid: { left: 50, right: 20, top: 30, bottom: 40 },
        xAxis: { type: "category", data: dates, axisLabel: { rotate: 35 } },
        yAxis: { type: "value" },
        series: [{
          name: "资金(U)",
          type: "line",
          data: funds,
          smooth: true,
          symbolSize: 8,
          lineStyle: { width: 3 }
        }],
        tooltip: { trigger: "axis" }
      });

      const pnlChart = echarts.init(document.getElementById("chartPnl"));
      pnlChart.setOption({
        grid: { left: 60, right: 20, top: 30, bottom: 40 },
        xAxis: { type: "category", data: dates, axisLabel: { rotate: 35 } },
        yAxis: { type: "value" },
        series: [{
          name: "已实现盈亏(U)",
          type: "bar",
          data: realizedPnlU,
          itemStyle: {
            color: (p) => (Number(p.value) >= 0 ? "#22c55e" : "#ef4444")
          },
          markLine: {
            symbol: "none",
            lineStyle: { color: "#94a3b8", type: "dashed" },
            data: [{ yAxis: 0, name: "0" }]
          }
        }],
        tooltip: { trigger: "axis" }
      });

      window.addEventListener("resize", () => {
        emotionChart.resize();
        decisionChart.resize();
        fundsChart.resize();
        pnlChart.resize();
      });

      const checkinForm = document.getElementById("checkinForm");
      if (checkinForm) {
        const msgEl = document.getElementById("formMsg");
        checkinForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          msgEl.textContent = "";
          const submitBtn = checkinForm.querySelector('button[type="submit"]');
          submitBtn.disabled = true;
          try {
            const formData = new FormData(checkinForm);
            const payload = {};
            for (const [k, v] of formData.entries()) payload[k] = String(v ?? "").trim();
            const res = await fetch("/api/checkin", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              msgEl.textContent = data && data.error ? data.error : "提交失败";
              return;
            }
            window.location.reload();
          } catch (err) {
            msgEl.textContent = String(err && err.message ? err.message : err);
          } finally {
            submitBtn.disabled = false;
          }
        });
      }

      const importCsvInput = document.getElementById("importCsvInput");
      if (importCsvInput) {
        importCsvInput.addEventListener("change", async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          const msgEl = document.getElementById("formMsg") || document.createElement("div");
          msgEl.textContent = "导入中...";
          try {
            const text = await file.text();
            const res = await fetch("/api/import", {
              method: "POST",
              headers: { "Content-Type": "text/csv" },
              body: text,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              msgEl.textContent = data && data.error ? data.error : "导入失败";
              return;
            }
            alert("导入成功，刷新页面！");
            window.location.reload();
          } catch (err) {
            msgEl.textContent = String(err && err.message ? err.message : err);
          } finally {
            importCsvInput.value = "";
          }
        });
      }

      async function updateCryptoPrices() {
        try {
          const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbols=%5B%22BNBUSDT%22,%22ETHUSDT%22,%22SOLUSDT%22%5D');
          if (!res.ok) return;
          const data = await res.json();
          const prices = {};
          data.forEach(item => {
            if(item.symbol === 'BNBUSDT') prices.BNB = parseFloat(item.price);
            if(item.symbol === 'ETHUSDT') prices.ETH = parseFloat(item.price);
            if(item.symbol === 'SOLUSDT') prices.SOL = parseFloat(item.price);
          });
          document.querySelectorAll('.crypto-equiv').forEach(el => {
            const u = parseFloat(el.getAttribute('data-u'));
            if(isNaN(u)) return;
            const bnb = prices.BNB ? (u / prices.BNB).toFixed(4) : '?';
            const eth = prices.ETH ? (u / prices.ETH).toFixed(4) : '?';
            const sol = prices.SOL ? (u / prices.SOL).toFixed(3) : '?';
            el.innerHTML = \`\${u.toFixed(2)}U <span style="color:#64748b;font-size:0.9em;font-weight:normal;">(≈ \${bnb} BNB | \${eth} ETH | \${sol} SOL)</span>\`;
          });
        } catch(e) {
          console.error('Failed to fetch crypto prices:', e);
        }
      }
      updateCryptoPrices();
      setInterval(updateCryptoPrices, 30000); // refresh every 30s
    </script>
  </body>
</html>`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeExpectation(expectationCodeOrText) {
  const v = String(expectationCodeOrText || "").trim();
  if (v === "A") return "正常执行计划";
  if (v === "B") return "想大赚一笔";
  if (v === "C") return "必须翻红";
  if (v === "正常执行计划" || v === "想大赚一笔" || v === "必须翻红") return v;
  return "正常执行计划";
}

function buildRecord(input) {
  const date = input.date || todayISODate();
  const totalFundsU = input.total_funds_u !== undefined ? Number(input.total_funds_u) : NaN;
  const mood = input.mood || "轻微焦虑";
  const wantRecoverStrength = input.want_recover_strength || "无";
  const lossReaction = input.loss_reaction || "A";
  const bodyState = input.body_state || "正常";
  const expectation = normalizeExpectation(input.expectation_code || input.expectation);

  const stable = input.stable || "否";
  const fomo = input.fomo || "否";
  const acceptDailyLoss = input.accept_daily_loss || "否";

  const todayTradeStatus = input.today_trade_status || "未交易";
  const todayRealizedPnlU = input.today_realized_pnl_u || "";
  const todayTradesCount = input.today_trades_count || "";

  const symbol = input.symbol || "";
  const mc = input.mc || "";
  const liquidity = input.liquidity || "";
  const holdingTime = input.holding_time || "";
  const stopLossPct = input.stop_loss_pct || "";

  const notes = input.notes || "";

  const { score: emotionScore, suggestion: emotionSuggestion, revengeTradingRisk } = scoreEmotion({
    mood,
    wantRecoverStrength,
    lossReaction,
    bodyState,
    expectation,
  });

  const risk = calcRisk(totalFundsU);

  let finalTradeDecision = "放弃";
  if (emotionScore <= 6) finalTradeDecision = "禁止交易";
  else if (emotionScore === 7) finalTradeDecision = "谨慎小仓";
  else finalTradeDecision = "执行";

  if (stable !== "是" || fomo === "是" || acceptDailyLoss !== "是") {
    if (finalTradeDecision === "执行") finalTradeDecision = "谨慎小仓";
    if (emotionScore <= 6) finalTradeDecision = "禁止交易";
  }

  let suggestedPositionU = "";
  const sl = Number(stopLossPct);
  if (Number.isFinite(sl) && sl !== 0 && Number.isFinite(totalFundsU) && totalFundsU > 0) {
    const singleRiskU = Number.isFinite(risk.singleRiskMaxU) ? risk.singleRiskMaxU : totalFundsU * 0.006;
    const maxPositionU = singleRiskU / Math.abs(sl / 100);
    suggestedPositionU = formatNumber(maxPositionU, 2);
  }

  const headers = [
    "date",
    "total_funds_u",
    "single_risk_min_u",
    "single_risk_max_u",
    "daily_max_loss_u",
    "weekly_max_drawdown_min_u",
    "weekly_max_drawdown_max_u",
    "mood",
    "want_recover_strength",
    "loss_reaction",
    "body_state",
    "expectation",
    "emotion_score",
    "emotion_suggestion",
    "stable",
    "fomo",
    "accept_daily_loss",
    "revenge_trading_risk",
    "symbol",
    "mc",
    "liquidity",
    "holding_time",
    "stop_loss_pct",
    "suggested_position_u",
    "today_trade_status",
    "today_realized_pnl_u",
    "today_trades_count",
    "final_trade_decision",
    "notes",
  ];

  const row = {
    date,
    total_funds_u: Number.isFinite(totalFundsU) ? formatNumber(totalFundsU, 2) : "",
    single_risk_min_u: formatNumber(risk.singleRiskMinU, 2),
    single_risk_max_u: formatNumber(risk.singleRiskMaxU, 2),
    daily_max_loss_u: formatNumber(risk.dailyMaxLossU, 2),
    weekly_max_drawdown_min_u: formatNumber(risk.weeklyMaxDrawdownMinU, 2),
    weekly_max_drawdown_max_u: formatNumber(risk.weeklyMaxDrawdownMaxU, 2),
    mood,
    want_recover_strength: wantRecoverStrength,
    loss_reaction: lossReaction,
    body_state: bodyState,
    expectation,
    emotion_score: String(emotionScore),
    emotion_suggestion: emotionSuggestion,
    stable,
    fomo,
    accept_daily_loss: acceptDailyLoss,
    revenge_trading_risk: revengeTradingRisk ? "是" : "否",
    symbol,
    mc,
    liquidity,
    holding_time: holdingTime,
    stop_loss_pct: stopLossPct,
    suggested_position_u: suggestedPositionU,
    today_trade_status: todayTradeStatus,
    today_realized_pnl_u: todayRealizedPnlU,
    today_trades_count: todayTradesCount,
    final_trade_decision: finalTradeDecision,
    notes,
  };

  return { headers, row, summary: { emotionScore, emotionSuggestion, finalTradeDecision, revengeTradingRisk } };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function runServer({ port, host, allowPortFallback }) {
  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url || "/", true);
    const pathname = parsed.pathname || "/";

    if (req.method === "GET" && (pathname === "/" || pathname === "/dashboard")) {
      const rows = readCsv(RECORDS_CSV_PATH);
      const html = generateDashboardHtml(rows, { withForm: true, showCliHint: false });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && pathname === "/daily_records.csv") {
      if (!fs.existsSync(RECORDS_CSV_PATH)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("daily_records.csv 不存在");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
      fs.createReadStream(RECORDS_CSV_PATH).pipe(res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/records") {
      const rows = readCsv(RECORDS_CSV_PATH);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ rows }));
      return;
    }

    if (req.method === "POST" && pathname === "/api/checkin") {
      try {
        const bodyText = await readRequestBody(req);
        let payload = {};
        const contentType = String(req.headers["content-type"] || "");
        if (contentType.includes("application/json")) {
          payload = bodyText ? JSON.parse(bodyText) : {};
        } else if (contentType.includes("application/x-www-form-urlencoded")) {
          const params = new URLSearchParams(bodyText);
          for (const [k, v] of params.entries()) payload[k] = v;
        } else {
          payload = bodyText ? JSON.parse(bodyText) : {};
        }

        const { headers, row, summary } = buildRecord(payload);
        ensureCsvHeaders(RECORDS_CSV_PATH, headers);
        writeCsvRow(RECORDS_CSV_PATH, headers, row);

        const rows = readCsv(RECORDS_CSV_PATH);
        fs.writeFileSync(DASHBOARD_HTML_PATH, generateDashboardHtml(rows), "utf8");

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, summary }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(err && err.message ? err.message : err) }));
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/import") {
      try {
        const bodyText = await readRequestBody(req);
        if (!bodyText || !bodyText.includes("date")) {
          throw new Error("Invalid CSV format");
        }
        
        // Very basic merge: just append lines, skip the header if it matches, and rewrite
        // We will read existing rows, read new rows from the uploaded text, combine by date (or just append)
        const lines = bodyText.split(/\r?\n/).filter(line => line.trim());
        if (lines.length < 2) throw new Error("No data in CSV");
        
        const importedHeaders = lines[0].split(",");
        const importedRows = lines.slice(1).map(line => {
          const vals = line.split(",");
          const obj = {};
          importedHeaders.forEach((h, i) => obj[h] = vals[i] || "");
          return obj;
        });

        // Merge with existing
        const existingRows = fs.existsSync(RECORDS_CSV_PATH) ? readCsv(RECORDS_CSV_PATH) : [];
        const combined = [...existingRows, ...importedRows];
        
        // Sort by date ascending
        combined.sort((a, b) => (a.date || "").localeCompare(b.date || ""));

        // Rewrite CSV
        if (combined.length > 0) {
          const allHeaders = Object.keys(combined[combined.length - 1]); // Use last row's headers
          const headerLine = allHeaders.join(",");
          const contentLines = combined.map(row => {
            return allHeaders.map(h => {
              const val = String(row[h] || "").replaceAll('"', '""');
              return val.includes(",") ? `"${val}"` : val;
            }).join(",");
          });
          fs.writeFileSync(RECORDS_CSV_PATH, [headerLine, ...contentLines].join("\n") + "\n", "utf8");
        }

        const newRows = readCsv(RECORDS_CSV_PATH);
        const html = generateDashboardHtml(newRows, { withForm: false, showCliHint: false });
        fs.writeFileSync(DASHBOARD_HTML_PATH, html, "utf8");

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, count: importedRows.length }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  });

  async function listenOnPort(p) {
    await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      server.once("error", onError);
      server.listen(p, host, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
  }

  let chosenPort = port;
  let started = false;
  const maxAttempts = allowPortFallback ? 20 : 1;
  for (let i = 0; i < maxAttempts; i += 1) {
    const p = port + i;
    try {
      await listenOnPort(p);
      chosenPort = p;
      started = true;
      break;
    } catch (err) {
      if (allowPortFallback && err && err.code === "EADDRINUSE") continue;
      throw err;
    }
  }

  if (!started) {
    throw new Error(allowPortFallback ? `端口占用：${port}~${port + 19} 都无法监听` : `端口占用：${port}`);
  }

  if (allowPortFallback && chosenPort !== port) {
    process.stdout.write(`端口 ${port} 已被占用，已自动切换到 ${chosenPort}\n`);
  }
  process.stdout.write(`监听： ${host}:${chosenPort}\n`);
  process.stdout.write(`打开： http://localhost:${chosenPort}/\n`);
}

async function runCheckin() {
  const rl = createReadline();
  try {
    const date = (await ask(rl, `日期（YYYY-MM-DD，默认：${todayISODate()}）：`)) || todayISODate();
    const totalFundsUInput = await ask(rl, "当前总资金（U，例如 50）：");
    const totalFundsU = totalFundsUInput ? Number(totalFundsUInput) : NaN;

    const mood = await askChoice(
      rl,
      "1) 我今天整体心情如何？",
      ["平静", "轻微焦虑", "明显烦躁", "非常冲动", "绝望"],
      "轻微焦虑"
    );

    const wantRecover = await askYesNo(rl, "2) 现在是否有“想回本/必须赚回来”的想法？", "否");
    let wantRecoverStrength = "无";
    if (wantRecover === "是") {
      wantRecoverStrength = await askChoice(rl, "2.1) 强度如何？", ["弱", "中", "强"], "弱");
    }

    const lossReaction = await askChoice(
      rl,
      "3) 若亏掉计划最大金额，你第一反应？",
      ["A", "B", "C"],
      "A"
    );

    const bodyState = await askChoice(
      rl,
      "4) 当前身体状态？",
      ["正常", "有点紧张", "心跳明显加快"],
      "正常"
    );

    const expectationCode = await askChoice(
      rl,
      "5) 对今天交易的期待？A=正常执行计划 / B=想大赚一笔 / C=必须翻红",
      ["A", "B", "C"],
      "A"
    );
    const expectation =
      expectationCode === "A"
        ? "正常执行计划"
        : expectationCode === "B"
          ? "想大赚一笔"
          : "必须翻红";

    const stable = await askYesNo(rl, "交易资格检查：你觉得现在情绪稳定吗？", "否");
    const fomo = await askYesNo(rl, "交易资格检查：现在是否FOMO？", "否");
    const acceptDailyLoss = await askYesNo(
      rl,
      "交易资格检查：能接受单日最大亏损后立刻停手吗？",
      "否"
    );

    let symbol = "";
    let mc = "";
    let liquidity = "";
    let holdingTime = "";
    let stopLossPct = "";
    if (true) {
      const willTrade = await askYesNo(rl, "今天是否确实要做交易机会评估？", "否");
      if (willTrade === "是") {
        symbol = await ask(rl, "币种（例如 DOGE）：");
        mc = await ask(rl, "当前MC（可填数字或文本）：");
        liquidity = await ask(rl, "流动性情况（简述）：");
        holdingTime = await ask(rl, "预计持仓时间（例如 15min/2h）：");
        stopLossPct = await ask(rl, "最大止损比例（默认-20，最多-28，填数字例如 -25）：");
      }
    }

    const todayTradeStatus = await askChoice(
      rl,
      "今天实际交易情况？",
      ["未交易", "模拟", "实盘"],
      "未交易"
    );
    let todayRealizedPnlU = "";
    let todayTradesCount = "";
    if (todayTradeStatus !== "未交易") {
      todayRealizedPnlU = await ask(rl, "当日已实现盈亏（U，可空；亏损填负数，例如 -0.8）：");
      todayTradesCount = await ask(rl, "当日交易笔数（可空）：");
    }

    const notes = await ask(rl, "备注（可空）：");

    const { headers, row, summary } = buildRecord({
      date,
      total_funds_u: totalFundsUInput,
      mood,
      want_recover_strength: wantRecoverStrength,
      loss_reaction: lossReaction,
      body_state: bodyState,
      expectation,
      stable,
      fomo,
      accept_daily_loss: acceptDailyLoss,
      symbol,
      mc,
      liquidity,
      holding_time: holdingTime,
      stop_loss_pct: stopLossPct,
      today_trade_status: todayTradeStatus,
      today_realized_pnl_u: todayRealizedPnlU,
      today_trades_count: todayTradesCount,
      notes,
    });

    ensureCsvHeaders(RECORDS_CSV_PATH, headers);
    writeCsvRow(RECORDS_CSV_PATH, headers, row);

    const rows = readCsv(RECORDS_CSV_PATH);
    fs.writeFileSync(DASHBOARD_HTML_PATH, generateDashboardHtml(rows), "utf8");

    process.stdout.write("\n已写入：daily_records.csv\n");
    process.stdout.write("已生成：dashboard.html（直接双击打开）\n\n");
    process.stdout.write(`情绪分：${summary.emotionScore}/10；情绪建议：${summary.emotionSuggestion}\n`);
    process.stdout.write(`最终决策：${summary.finalTradeDecision}\n`);
    if (summary.revengeTradingRisk) {
      process.stdout.write("警告：存在报复性交易风险信号（想回本/加仓倾向/必须翻红）。\n");
    }
  } finally {
    rl.close();
  }
}

function runDashboard() {
  const rows = readCsv(RECORDS_CSV_PATH);
  fs.writeFileSync(DASHBOARD_HTML_PATH, generateDashboardHtml(rows), "utf8");
  process.stdout.write("已生成：dashboard.html\n");
}

function printHelp() {
  process.stdout.write(
    [
      "用法：",
      "  node trade-review.js checkin   录入当天情绪+风控结果，追加到 daily_records.csv，并生成 dashboard.html",
      "  node trade-review.js dashboard 仅根据 daily_records.csv 重新生成 dashboard.html",
      "  node trade-review.js serve     启动本地页面（可在网页填写打卡）",
      "",
      "输出：",
      "  daily_records.csv  可直接用 Excel 打开",
      "  dashboard.html     ECharts 可视化看板（本地打开即可）",
      "",
    ].join("\n")
  );
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }
  if (cmd === "checkin") {
    await runCheckin();
    return;
  }
  if (cmd === "dashboard") {
    runDashboard();
    return;
  }
  if (cmd === "serve") {
    const portArg = process.argv.find((a) => a.startsWith("--port="));
    const portFromArg = portArg ? Number(portArg.split("=")[1]) : NaN;
    const portFromEnv = process.env.PORT ? Number(process.env.PORT) : NaN;
    const port = Number.isFinite(portFromArg) ? portFromArg : Number.isFinite(portFromEnv) ? portFromEnv : 3060;
    const allowPortFallback = !Number.isFinite(portFromArg) && !Number.isFinite(portFromEnv);
    const host = process.env.HOST ? String(process.env.HOST) : "0.0.0.0";
    await runServer({ port, host, allowPortFallback });
    return;
  }
  printHelp();
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
  process.exitCode = 1;
});
