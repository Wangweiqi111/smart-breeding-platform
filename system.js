/* ===================================================================
   智慧养殖平台 · 养殖系统页逻辑
   - 存栏台账：入库 / 出栏 / 淘汰 流水，自动计算当前存栏
   - 环境曲线：Canvas 手绘折线图，支持模拟数据与 Web Serial 真实串口
   - 设备状态：可开关，状态写入 localStorage
   =================================================================== */

(function () {

  const K = { herds: 'sbp_herds', env: 'sbp_env', dev: 'sbp_devices' };

  /* ---------- 阈值配置 ---------- */
  const TH = {
    temp: { label: '当前温度', unit: '℃',  warn: 28, min: 18, max: 28 },
    hum:  { label: '环境湿度', unit: '%',   warn: 75, min: 40, max: 75 },
    nh3:  { label: '氨气浓度', unit: 'ppm', warn: 20, min: 0,  max: 20 }
  };

  let herds   = SBP.get(K.herds, null);
  let env     = SBP.get(K.env, null);
  let devices = SBP.get(K.dev, null);

  let metric   = 'temp';
  let simTimer = null;
  let serialOn = false;
  let serialPort = null;
  let serialReader = null;

  /* ---------- 默认数据（首次打开时写入） ---------- */
  function seed() {
    herds = [
      { id: 1, date: '2026-03-12', house: '1 号猪舍', breed: '生猪', type: 'in', count: 80,  note: '春季补栏', source: '人工录入' },
      { id: 2, date: '2026-03-12', house: '2 号猪舍', breed: '母猪', type: 'in', count: 12,  note: '', source: '人工录入' },
      { id: 3, date: '2026-04-02', house: '1 号猪舍', breed: '仔猪', type: 'in', count: 31,  note: '新产仔猪', source: '人工录入' },
      { id: 4, date: '2026-04-02', house: '牛舍',     breed: '肉牛', type: 'in', count: 24,  note: '', source: '人工录入' },
      { id: 5, date: '2026-04-02', house: '鸡舍',     breed: '蛋鸡', type: 'in', count: 260, note: '', source: '人工录入' }
    ];
    devices = [
      { key: 'temp',  name: '温控系统', on: true,  meta: '目标 24℃' },
      { key: 'feed',  name: '投喂系统', on: true,  meta: '每日 3 次' },
      { key: 'cam',   name: '监控设备', on: true,  meta: '4 路' },
      { key: 'vent',  name: '通风设备', on: true,  meta: '自动档' }
    ];
    // 造 30 个历史点，间隔 30 秒
    env = [];
    let t = Date.now() - 30 * 30 * 1000;
    let temp = 24.0, hum = 62, nh3 = 12;
    for (let i = 0; i < 30; i++) {
      temp += (Math.random() - 0.5) * 0.8;
      hum  += (Math.random() - 0.5) * 3;
      nh3  += (Math.random() - 0.5) * 1.6;
      temp = clamp(temp, 20, 29); hum = clamp(hum, 50, 74); nh3 = clamp(nh3, 6, 19);
      env.push({ t: t, temp: r1(temp), hum: Math.round(hum), nh3: r1(nh3) });
      t += 30000;
    }
    saveAll();
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const r1 = v => Math.round(v * 10) / 10;

  function saveAll() {
    SBP.set(K.herds, herds);
    SBP.set(K.env, env);
    SBP.set(K.dev, devices);
  }

  /* ---------- 存栏计算 ---------- */
  const sign = type => (type === 'in' ? 1 : -1);
  function stockTotal() {
    return herds.reduce((s, r) => s + sign(r.type) * r.count, 0);
  }
  function stockByHouse() {
    const m = {};
    herds.forEach(r => { m[r.house] = (m[r.house] || 0) + sign(r.type) * r.count; });
    return m;
  }
  function stockOfBreed(breed) {
    return herds.filter(r => r.breed === breed)
                .reduce((s, r) => s + sign(r.type) * r.count, 0);
  }
  function totalOut() {
    return herds.filter(r => r.type !== 'in')
                .reduce((s, r) => s + r.count, 0);
  }

  /* ---------- 环境告警 ---------- */
  function alertList() {
    const a = [];
    const last = env[env.length - 1];
    if (last) {
      if (last.temp > TH.temp.warn) a.push('温度偏高 ' + last.temp + '℃');
      if (last.temp < TH.temp.min)  a.push('温度偏低 ' + last.temp + '℃');
      if (last.hum  > TH.hum.warn)  a.push('湿度偏高 ' + last.hum + '%');
      if (last.nh3  > TH.nh3.warn)  a.push('氨气超标 ' + last.nh3 + 'ppm');
    }
    devices.forEach(d => { if (!d.on) a.push(d.name + '已关闭'); });
    return a;
  }

  /* ---------- 渲染 ---------- */
  function box(num, lab, cls) {
    return '<div class="data-box ' + (cls || '') + '">' +
           '<span class="num">' + num + '</span>' +
           '<span class="lab">' + lab + '</span></div>';
  }
  function badge(text, cls) {
    return '<span class="badge badge-' + cls + '">' + text + '</span>';
  }

  function renderKpi() {
    const alerts = alertList();
    const online = devices.filter(d => d.on).length;
    document.getElementById('kpi').innerHTML =
      box(stockTotal(), '当前存栏（头 / 只）') +
      box(Object.keys(stockByHouse()).length, '在册栋舍') +
      box(alerts.length, '当前告警', alerts.length ? 'is-danger' : '') +
      box(online + ' / ' + devices.length, '设备在线');
  }

  function renderHerdStat() {
    document.getElementById('herdStat').innerHTML =
      box(stockTotal(), '总存栏') +
      box(stockOfBreed('母猪'), '母猪存栏') +
      box(stockOfBreed('仔猪'), '仔猪存栏') +
      box(totalOut(), '累计出栏 / 淘汰');
  }

  function renderTable() {
    const tb = document.getElementById('herdTable');
    if (!herds.length) {
      tb.innerHTML = '<tr><td colspan="8" class="empty">暂无记录，请在上方录入</td></tr>';
      return;
    }
    const typeText = { in: '入库', out: '出栏', cull: '淘汰' };
    const typeCls  = { in: 'ok', out: 'warn', cull: 'danger' };
    tb.innerHTML = herds.slice().reverse().map(r =>
      '<tr>' +
        '<td>' + SBP.esc(r.date) + '</td>' +
        '<td>' + SBP.esc(r.house) + '</td>' +
        '<td>' + SBP.esc(r.breed) + '</td>' +
        '<td>' + badge(typeText[r.type], typeCls[r.type]) + '</td>' +
        '<td class="num">' + (r.type === 'in' ? '+' : '-') + r.count + '</td>' +
        '<td>' + SBP.esc(r.source || '人工录入') + '</td>' +
        '<td>' + SBP.esc(r.note || '-') + '</td>' +
        '<td><button type="button" class="mini" data-del="' + r.id + '">删除</button></td>' +
      '</tr>'
    ).join('');
    tb.querySelectorAll('[data-del]').forEach(btn => {
      btn.onclick = function () {
        const id = +btn.getAttribute('data-del');
        herds = herds.filter(r => r.id !== id);
        saveAll(); renderAll();
      };
    });
  }

  function renderBar() {
    const m = stockByHouse();
    const data = Object.keys(m).map(k => ({ label: k, value: m[k] }));
    SBP.barChart(document.getElementById('barHouse'), data);
  }

  function renderEnv() {
    const last = env[env.length - 1];
    const vent = devices.find(d => d.key === 'vent');
    const tb = last ? last.temp : '--';
    const hb = last ? last.hum : '--';
    const nb = last ? last.nh3 : '--';
    document.getElementById('envStat').innerHTML =
      box(tb + '℃', '当前温度',
          (last && (last.temp > TH.temp.warn || last.temp < TH.temp.min)) ? 'is-danger' : '') +
      box(hb + '%', '环境湿度', (last && last.hum > TH.hum.warn) ? 'is-warn' : '') +
      box(nb + 'ppm', '氨气浓度', (last && last.nh3 > TH.nh3.warn) ? 'is-danger' : '') +
      box(vent && vent.on ? '良好' : '已关闭', '通风状态',
          vent && vent.on ? '' : 'is-warn');

    const cfg = TH[metric];
    const series = env.map(p => ({ t: p.t, v: p[metric] }));
    SBP.lineChart(document.getElementById('lineEnv'), series, {
      color: metric === 'nh3' ? '#e08a0b' : '#2d8a2d',
      unit: cfg.unit,
      warn: cfg.warn
    });
  }

  function renderDevices() {
    const wrap = document.getElementById('deviceList');
    wrap.innerHTML = devices.map(d =>
      '<div class="switch-item">' +
        '<div><div class="name">' + SBP.esc(d.name) + '</div>' +
        '<div class="meta">' + SBP.esc(d.meta || '') + '</div></div>' +
        '<div>' + badge(d.on ? '运行中' : '已关闭', d.on ? 'ok' : 'idle') +
        '<button type="button" class="ghost" style="margin-left:8px" data-toggle="' + d.key + '">' +
        (d.on ? '关闭' : '开启') + '</button></div>' +
      '</div>'
    ).join('');
    wrap.querySelectorAll('[data-toggle]').forEach(btn => {
      btn.onclick = function () {
        const key = btn.getAttribute('data-toggle');
        const d = devices.find(x => x.key === key);
        if (d) { d.on = !d.on; saveAll(); renderAll(); }
      };
    });
  }

  function renderAll() {
    renderKpi(); renderHerdStat(); renderTable();
    renderBar(); renderEnv(); renderDevices();
  }

  /* ---------- 录入存栏记录 ---------- */
  const herdMsg = () => document.getElementById('herdMsg');
  function showHerd(text, type) {
    const m = herdMsg();
    m.textContent = text;
    m.className = 'msg show ' + type;
  }

  function addRecord(rec) {
    rec.id = herds.length ? Math.max.apply(null, herds.map(r => r.id)) + 1 : 1;
    herds.push(rec);
    saveAll(); renderAll();
  }

  document.getElementById('herdForm').addEventListener('submit', function (e) {
    e.preventDefault();
    const count = parseInt(document.getElementById('hCount').value, 10);
    if (!count || count <= 0) return showHerd('请输入大于 0 的数量', 'err');

    addRecord({
      date: document.getElementById('hDate').value || SBP.today(),
      house: document.getElementById('hHouse').value,
      breed: document.getElementById('hBreed').value,
      type: document.getElementById('hType').value,
      count: count,
      note: document.getElementById('hNote').value.trim(),
      source: '人工录入'
    });
    document.getElementById('hCount').value = '';
    document.getElementById('hNote').value = '';
    showHerd('已添加，当前存栏 ' + stockTotal() + ' 头 / 只', 'ok');
  });

  /* ---------- 盘点核对 ---------- */
  const checkMsg = () => document.getElementById('checkMsg');
  document.getElementById('btnCheck').onclick = function () {
    const real = parseInt(document.getElementById('realCount').value, 10);
    if (isNaN(real) || real < 0) {
      checkMsg().textContent = '请输入实盘头数';
      checkMsg().className = 'msg show err';
      return;
    }
    const book = stockTotal();
    const diff = real - book;
    let html;
    if (diff === 0) {
      html = '台账存栏 <b>' + book + '</b>，实盘 <b>' + real + '</b> —— 完全一致。';
      checkMsg().className = 'msg show ok';
    } else {
      html = '台账存栏 <b>' + book + '</b>，实盘 <b>' + real + '</b> —— ' +
             (diff > 0 ? '盘盈 ' : '盘亏 ') + Math.abs(diff) + ' 头。' +
             '<button type="button" class="ghost" style="margin-left:10px" id="btnFix">' +
             '写入调整记录</button>';
      checkMsg().className = 'msg show ' + (diff > 0 ? 'info' : 'err');
      checkMsg().innerHTML = html;
      document.getElementById('btnFix').onclick = function () {
        addRecord({
          date: SBP.today(),
          house: '其他',
          breed: '生猪',
          type: diff > 0 ? 'in' : 'out',
          count: Math.abs(diff),
          note: '盘点调整（实盘 ' + real + '）',
          source: '人工盘点'
        });
        checkMsg().textContent = '已写入调整记录，存栏更新为 ' + stockTotal() + '。';
        checkMsg().className = 'msg show ok';
      };
      return;
    }
    checkMsg().innerHTML = html;
  };

  /* ---------- 模拟一次视觉识别上报（演示用，明确标注为模拟） ---------- */
  document.getElementById('btnDemoVision').onclick = function () {
    const byHouse = stockByHouse();
    const house = '1 号猪舍';
    const book = byHouse[house] || 0;
    const seen = Math.max(0, book + Math.round((Math.random() - 0.5) * 6));
    const diff = seen - book;
    if (diff === 0) {
      checkMsg().innerHTML = '视觉识别结果：<b>' + seen + '</b> 头，与台账一致，无需调整。' +
        '<br><span style="font-size:12px">（演示：真实场景下由识别模型返回头数）</span>';
      checkMsg().className = 'msg show ok';
      return;
    }
    addRecord({
      date: SBP.today(),
      house: house,
      breed: '生猪',
      type: diff > 0 ? 'in' : 'out',
      count: Math.abs(diff),
      note: '视觉识别盘点（识别 ' + seen + ' 头 / 台账 ' + book + ' 头）',
      source: '视觉识别（模拟）'
    });
    checkMsg().innerHTML = '视觉识别 <b>' + seen + '</b> 头，台账 <b>' + book + '</b> 头，' +
      (diff > 0 ? '盘盈 ' : '盘亏 ') + Math.abs(diff) + ' 头，已自动写入调整记录。' +
      '<br><span style="font-size:12px">（演示：真实场景下由识别模型返回头数）</span>';
    checkMsg().className = 'msg show info';
  };

  /* ---------- 环境数据：模拟 / 串口 ---------- */
  function pushEnv(point) {
    env.push(point);
    if (env.length > 120) env.shift();
    SBP.set(K.env, env);
    renderKpi(); renderEnv();
  }

  function startSim() {
    if (simTimer) return;
    simTimer = setInterval(function () {
      const last = env[env.length - 1] || { temp: 24, hum: 62, nh3: 12 };
      pushEnv({
        t: Date.now(),
        temp: r1(clamp(last.temp + (Math.random() - 0.5) * 0.9, 20, 29.5)),
        hum:  Math.round(clamp(last.hum + (Math.random() - 0.5) * 3.4, 50, 76)),
        nh3:  r1(clamp(last.nh3 + (Math.random() - 0.5) * 1.8, 6, 21))
      });
    }, 3000);
    document.getElementById('btnSim').textContent = '停止模拟';
  }
  function stopSim() {
    if (simTimer) { clearInterval(simTimer); simTimer = null; }
    document.getElementById('btnSim').textContent = '开始模拟';
  }

  const serialMsg = () => document.getElementById('serialMsg');
  function showSerial(text, type) {
    const m = serialMsg();
    m.textContent = text;
    m.className = 'msg show ' + type;
  }

  function setSourceBadge(text, cls) {
    const b = document.getElementById('srcBadge');
    b.textContent = text;
    b.className = 'badge badge-' + cls;
  }

  /** 解析一行串口报文，支持 JSON 与 KEY:VALUE 两种 */
  function parseLine(line) {
    line = line.trim();
    if (!line) return null;
    if (line.charAt(0) === '{') {
      try {
        const o = JSON.parse(line);
        return {
          temp: num(o.temp !== undefined ? o.temp : o.TEMP),
          hum:  num(o.hum  !== undefined ? o.hum  : o.HUM),
          nh3:  num(o.nh3  !== undefined ? o.nh3  : o.NH3)
        };
      } catch (e) { return null; }
    }
    const out = {};
    line.split(/[,;\s]+/).forEach(function (part) {
      // 键名允许带数字（如 NH3），所以用 [A-Za-z0-9_]
      const m = part.match(/^([A-Za-z_][A-Za-z0-9_]*)[:=](-?\d+(?:\.\d+)?)$/);
      if (!m) return;
      const k = m[1].toUpperCase();
      if (k === 'TEMP' || k === 'T' || k === 'TEMPERATURE') out.temp = parseFloat(m[2]);
      else if (k === 'HUM' || k === 'H' || k === 'HUMIDITY') out.hum = parseFloat(m[2]);
      else if (k === 'NH3') out.nh3 = parseFloat(m[2]);
    });
    return (out.temp === undefined && out.hum === undefined && out.nh3 === undefined) ? null : out;
  }
  const num = v => (v === undefined || v === null || isNaN(+v)) ? undefined : +v;

  function handleLine(line) {
    const p = parseLine(line);
    const tb = document.getElementById('rawTable');
    const bd = document.getElementById('rawBody');
    tb.style.display = '';
    const row = document.createElement('tr');
    row.innerHTML = '<td>' + new Date().toLocaleTimeString('zh-CN') + '</td>' +
      '<td>' + SBP.esc(line) + '</td>' +
      '<td>' + (p ? JSON.stringify(p) : '<span style="color:#d64545">无法解析</span>') + '</td>';
    bd.insertBefore(row, bd.firstChild);
    while (bd.children.length > 8) bd.removeChild(bd.lastChild);

    if (!p) return;
    const last = env[env.length - 1] || { temp: 24, hum: 62, nh3: 12 };
    pushEnv({
      t: Date.now(),
      temp: p.temp !== undefined ? p.temp : last.temp,
      hum:  p.hum  !== undefined ? p.hum  : last.hum,
      nh3:  p.nh3  !== undefined ? p.nh3  : last.nh3
    });
  }

  async function connectSerial() {
    if (!('serial' in navigator)) {
      showSerial('当前浏览器不支持 Web Serial API。请使用 Chrome / Edge，并通过 https 或 localhost 打开本页。', 'err');
      return;
    }
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      serialPort = port;
      serialOn = true;
      stopSim();
      setSourceBadge('串口实时', 'ok');
      showSerial('串口已连接（115200 8N1），等待下位机上报…', 'ok');
      document.getElementById('btnSerial').textContent = '断开串口';

      const decoder = new TextDecoderStream();
      const done = port.readable.pipeTo(decoder.writable);
      serialReader = decoder.readable.getReader();
      let buf = '';
      while (serialOn) {
        const res = await serialReader.read();
        if (res.done) break;
        buf += res.value;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          handleLine(line);
        }
      }
      await done.catch(() => {});
    } catch (e) {
      showSerial('串口连接失败：' + (e && e.message ? e.message : e), 'err');
      serialOn = false;
    }
  }

  async function disconnectSerial() {
    serialOn = false;
    try { if (serialReader) await serialReader.cancel(); } catch (e) {}
    try { if (serialPort) await serialPort.close(); } catch (e) {}
    serialPort = null; serialReader = null;
    setSourceBadge('模拟数据', 'idle');
    document.getElementById('btnSerial').textContent = '连接串口（USB）';
    showSerial('串口已断开。', 'info');
  }

  /* ---------- 事件绑定 ---------- */
  document.getElementById('btnSerial').onclick = function () {
    if (serialOn) disconnectSerial(); else connectSerial();
  };
  document.getElementById('btnSim').onclick = function () {
    if (simTimer) { stopSim(); showSerial('已停止模拟数据。', 'info'); }
    else { startSim(); showSerial('已开始模拟数据（每 3 秒一个点）。', 'info'); }
  };
  document.getElementById('btnClearEnv').onclick = function () {
    env = []; SBP.set(K.env, env); renderEnv(); renderKpi();
    document.getElementById('rawBody').innerHTML = '';
  };
  document.getElementById('envMetric').onchange = function () {
    metric = this.value; renderEnv();
  };
  window.addEventListener('resize', function () { renderBar(); renderEnv(); });

  /* ---------- 初始化 ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    if (!herds || !env || !devices) seed();
    document.getElementById('hDate').value = SBP.today();
    renderAll();
    startSim();
  });

})();
