// ============================================================
// stats.js : thu thập getStats() và vẽ biểu đồ  (BƯỚC 5)
//
// Mỗi giây, với từng peer đang "connected", gọi pc.getStats() rồi tính:
//   - bitrate nhận/gửi (kbps)  : chênh lệch bytes giữa hai lần đo
//   - packet loss nhận (%)     : chênh lệch packetsLost / (packetsLost + packetsReceived)
//   - jitter (ms)              : lấy trực tiếp từ inbound-rtp
//   - RTT (ms)                 : từ candidate-pair đang được chọn
//   - FPS và độ phân giải      : từ inbound-rtp của video
//   - loại candidate được chọn : host / srflx / prflx / relay (STUN hay TURN)
//
// Dữ liệu được: (1) hiện thành bảng, (2) vẽ biểu đồ Chart.js, (3) xuất CSV
// cho chương thí nghiệm. File này đọc `peers`, `room` (core.js) và dùng
// `log`, `short` (debug.js).
// ============================================================

const STATS_INTERVAL_MS = 1000;   // chu kỳ đo
const STATS_WINDOW = 60;          // biểu đồ chỉ giữ 60 điểm gần nhất
const STATS_MAX_ROWS = 20000;     // giới hạn lịch sử cho CSV (~5 giờ với 1 peer)
const STATS_COLORS = ['#1a73e8', '#e8710a', '#188038', '#a142f4', '#d93025', '#00897b'];

// key = tên trường trong số liệu đo; title = tiêu đề biểu đồ
const STAT_CHARTS = [
  { key: 'inKbps',   title: 'Bitrate nhận (kbps)' },
  { key: 'outKbps',  title: 'Bitrate gửi (kbps)' },
  { key: 'rttMs',    title: 'RTT (ms)' },
  { key: 'jitterMs', title: 'Jitter (ms)' },
  { key: 'lossPct',  title: 'Packet loss nhận (%)' },
  { key: 'fps',      title: 'Khung hình/giây (nhận)' },
];

// Các cột trong file CSV (đúng thứ tự)
const STATS_CSV_COLS = [
  'time', 'elapsed_s', 'scenario', 'room', 'peer', 'participants',
  'local_candidate', 'remote_candidate',
  'rtt_ms', 'jitter_ms', 'loss_pct', 'in_kbps', 'out_kbps', 'fps', 'width', 'height',
];

const statsRows = [];                  // lịch sử đo, mỗi dòng = 1 peer tại 1 thời điểm
const statsPrev = new Map();           // peerId -> bộ đếm lần đo trước (để tính tốc độ)
const statsLatest = new Map();         // peerId -> số liệu mới nhất (cho bảng)
const statsStartMs = performance.now();
const chartData = { labels: [], series: {} };   // series[key] = Map(peerId -> mảng giá trị)
STAT_CHARTS.forEach((c) => { chartData.series[c.key] = new Map(); });
const statsColorOf = new Map();        // peerId -> màu cố định
let statsVisible = false;
let chartObjs = null;                  // các đối tượng Chart.js (tạo khi mở panel lần đầu)
let statsBusy = false;
let statsScenario = '';

const round1 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 10) / 10);

function colorFor(id) {
  if (!statsColorOf.has(id)) statsColorOf.set(id, STATS_COLORS[statsColorOf.size % STATS_COLORS.length]);
  return statsColorOf.get(id);
}

// ---------- 1. Đo một peer ----------
async function collectPeerStats(id, peer) {
  const report = await peer.pc.getStats();

  let outBytes = 0, inBytes = 0, inPackets = 0, inLost = 0;
  let jitter = null, fps = null, width = null, height = null, remoteRtt = null;
  let pair = null;

  report.forEach((r) => {
    if (r.type === 'outbound-rtp') {
      outBytes += r.bytesSent || 0;                       // audio + video
    } else if (r.type === 'inbound-rtp') {
      inBytes += r.bytesReceived || 0;
      inPackets += r.packetsReceived || 0;
      inLost += Math.max(0, r.packetsLost || 0);          // packetsLost có thể âm do gói trùng
      if (r.kind === 'video') {
        if (r.jitter != null) jitter = r.jitter;          // ưu tiên jitter của video
        if (r.framesPerSecond != null) fps = r.framesPerSecond;
        if (r.frameWidth) { width = r.frameWidth; height = r.frameHeight; }
      } else if (jitter === null && r.jitter != null) {
        jitter = r.jitter;                                // không có video thì dùng audio
      }
    } else if (r.type === 'remote-inbound-rtp') {
      if (r.roundTripTime != null) remoteRtt = r.roundTripTime;   // RTT do bên kia báo về
    } else if (r.type === 'candidate-pair') {
      if (r.state === 'succeeded' && (r.nominated || r.selected)) pair = pair && !r.nominated ? pair : r;
    }
  });
  // Cách chính xác nhất để biết cặp candidate đang dùng: transport.selectedCandidatePairId
  report.forEach((r) => {
    if (r.type === 'transport' && r.selectedCandidatePairId) {
      const p = report.get(r.selectedCandidatePairId);
      if (p) pair = p;
    }
  });

  const local = pair ? report.get(pair.localCandidateId) : null;
  const remote = pair ? report.get(pair.remoteCandidateId) : null;
  const rttSec = pair && pair.currentRoundTripTime != null ? pair.currentRoundTripTime : remoteRtt;

  // Tốc độ = chênh lệch bộ đếm giữa hai lần đo / thời gian giữa hai lần đo
  const now = performance.now();
  const prev = statsPrev.get(id);
  statsPrev.set(id, { now, outBytes, inBytes, inPackets, inLost });

  let inKbps = null, outKbps = null, lossPct = null;
  if (prev) {
    const dt = (now - prev.now) / 1000;
    const dIn = inBytes - prev.inBytes;
    const dOut = outBytes - prev.outBytes;
    const dPk = inPackets - prev.inPackets;
    const dLost = inLost - prev.inLost;
    if (dt > 0) {
      if (dIn >= 0) inKbps = (dIn * 8) / dt / 1000;
      if (dOut >= 0) outKbps = (dOut * 8) / dt / 1000;
    }
    if (dPk >= 0 && dLost >= 0 && dPk + dLost > 0) lossPct = (dLost / (dPk + dLost)) * 100;
  }

  return {
    inKbps: round1(inKbps),
    outKbps: round1(outKbps),
    lossPct: round1(lossPct),
    rttMs: round1(rttSec != null ? rttSec * 1000 : null),
    jitterMs: round1(jitter != null ? jitter * 1000 : null),
    fps: round1(fps),
    width, height,
    local: local ? `${local.candidateType}/${local.protocol}` : '',
    remote: remote ? `${remote.candidateType}/${remote.protocol}` : '',
  };
}

// ---------- 2. Lưu dữ liệu biểu đồ (cửa sổ trượt 60 điểm) ----------
function pushChartData(t, results) {
  chartData.labels.push(t);
  const n = chartData.labels.length;
  for (const c of STAT_CHARTS) {
    const series = chartData.series[c.key];
    for (const id of results.keys()) {
      if (!series.has(id)) series.set(id, new Array(n - 1).fill(null));   // peer mới: đệm null cho các điểm cũ
    }
    for (const [id, arr] of series) arr.push(results.has(id) ? results.get(id)[c.key] : null);
    if (n > STATS_WINDOW) for (const arr of series.values()) arr.shift();
    for (const [id, arr] of [...series]) if (arr.every((v) => v === null)) series.delete(id);
  }
  if (n > STATS_WINDOW) chartData.labels.shift();
}

// ---------- 3. Vòng lặp đo ----------
async function statsTick() {
  if (statsBusy) return;               // lần đo trước chưa xong thì bỏ qua
  statsBusy = true;
  try {
    const t = Math.round((performance.now() - statsStartMs) / 1000);

    // Dọn bộ đếm của peer đã rời phòng
    for (const id of [...statsPrev.keys()]) if (!peers.has(id)) statsPrev.delete(id);

    const active = [...peers].filter(([, p]) => p.pc.connectionState === 'connected');
    const results = new Map();
    await Promise.all(active.map(async ([id, p]) => {
      try { results.set(id, await collectPeerStats(id, p)); } catch (e) { /* peer vừa bị đóng */ }
    }));

    const scenario = statsScenario;
    statsLatest.clear();
    for (const [id, m] of results) {
      statsLatest.set(id, m);
      statsRows.push({
        time: new Date().toISOString(), elapsed_s: t, scenario, room,
        peer: short(id), participants: peers.size + 1,
        local_candidate: m.local, remote_candidate: m.remote,
        rtt_ms: m.rttMs, jitter_ms: m.jitterMs, loss_pct: m.lossPct,
        in_kbps: m.inKbps, out_kbps: m.outKbps, fps: m.fps, width: m.width, height: m.height,
      });
    }
    while (statsRows.length > STATS_MAX_ROWS) statsRows.shift();

    pushChartData(t, results);
    if (statsVisible) { renderStatsTable(); updateCharts(); }
  } finally {
    statsBusy = false;
  }
}

// ---------- 4. Bảng số liệu ----------
function renderStatsTable() {
  const tbody = document.querySelector('#statsTable tbody');
  tbody.textContent = '';
  const fmt = (v) => (v == null ? '–' : v);
  for (const [id, m] of statsLatest) {
    const cells = [
      short(id), `${m.local || '?'} ↔ ${m.remote || '?'}`,
      fmt(m.rttMs), fmt(m.jitterMs), fmt(m.lossPct), fmt(m.inKbps), fmt(m.outKbps), fmt(m.fps),
      m.width ? `${m.width}×${m.height}` : '–',
    ];
    const tr = document.createElement('tr');
    cells.forEach((v) => { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); });
    tbody.appendChild(tr);
  }
  if (statsLatest.size === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 9;
    td.textContent = 'Chưa có kết nối nào ở trạng thái connected';
    tr.appendChild(td); tbody.appendChild(tr);
  }
}

// ---------- 5. Biểu đồ Chart.js ----------
function ensureCharts() {
  if (chartObjs) return;
  const msg = document.getElementById('statsChartsMsg');
  if (typeof Chart === 'undefined') {
    msg.textContent = 'Không nạp được Chart.js (kiểm tra js/vendor/chart.umd.js). Vẫn có bảng số liệu và xuất CSV.';
    return;
  }
  msg.textContent = '';
  const holder = document.getElementById('statsCharts');
  chartObjs = {};
  for (const c of STAT_CHARTS) {
    const box = document.createElement('div');
    box.className = 'chartBox';
    const canvas = document.createElement('canvas');
    box.appendChild(canvas);
    holder.appendChild(box);
    chartObjs[c.key] = new Chart(canvas, {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: { title: { display: true, text: c.title }, legend: { position: 'bottom' } },
        scales: { x: { title: { display: true, text: 'giây' } }, y: { beginAtZero: true } },
      },
    });
  }
}

function updateCharts() {
  if (!chartObjs) return;
  for (const c of STAT_CHARTS) {
    const chart = chartObjs[c.key];
    chart.data.labels = chartData.labels.slice();
    chart.data.datasets = [...chartData.series[c.key]].map(([id, arr]) => ({
      label: short(id), data: arr.slice(),
      borderColor: colorFor(id), backgroundColor: colorFor(id),
      tension: 0.2, pointRadius: 0, borderWidth: 2, spanGaps: false,
    }));
    chart.update('none');
  }
}

// ---------- 6. Xuất CSV ----------
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildStatsCsv() {
  const lines = [STATS_CSV_COLS.join(',')];
  for (const row of statsRows) lines.push(STATS_CSV_COLS.map((c) => csvCell(row[c])).join(','));
  return lines.join('\n');
}

function exportStatsCsv() {
  if (statsRows.length === 0) { log(null, 'Chưa có dữ liệu thống kê để xuất'); return; }
  // BOM (\ufeff) để Excel đọc đúng tiếng Việt
  const blob = new Blob(['\ufeff' + buildStatsCsv()], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `meetlite-stats-${room}-${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  log(null, `Đã xuất CSV: ${statsRows.length} dòng`);
}

// ---------- 7. Nút bấm và khởi động ----------
document.getElementById('btnStats').onclick = () => {
  statsVisible = !statsVisible;
  document.getElementById('statsPanel').hidden = !statsVisible;
  document.getElementById('btnStats').textContent = statsVisible ? '📊 Ẩn thống kê' : '📊 Hiện thống kê';
  if (statsVisible) { ensureCharts(); renderStatsTable(); updateCharts(); }
};
document.getElementById('btnCsv').onclick = exportStatsCsv;
document.getElementById('statsLabel').addEventListener('change', (e) => {
  statsScenario = e.target.value.trim();
  log(null, `Nhãn thí nghiệm: "${statsScenario}"`);
});
document.getElementById('btnStatsClear').onclick = () => {
  statsRows.length = 0;
  chartData.labels.length = 0;
  for (const c of STAT_CHARTS) chartData.series[c.key].clear();
  if (statsVisible) { renderStatsTable(); updateCharts(); }
  log(null, 'Đã xóa dữ liệu thống kê');
};

setInterval(statsTick, STATS_INTERVAL_MS);   // luôn đo, kể cả khi panel đang ẩn
