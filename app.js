/* ===================================================================
   智慧养殖平台 · 公共脚本（账号体系 + 工具函数 + 手绘图表）
   原生 JavaScript，无框架。
   数据全部存放在浏览器 localStorage，不依赖后端服务器。
   =================================================================== */

const SBP = (function () {

  /* ---------- 存储键名 ---------- */
  const K = {
    users:   'sbp_users',     // 注册用户表
    session: 'sbp_session',   // 当前登录用户
    remember:'sbp_remember'   // 记住密码
  };

  /* ---------- 通用读写 ---------- */
  function get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : (fallback === undefined ? null : fallback);
    } catch (e) {
      return fallback === undefined ? null : fallback;
    }
  }
  function set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }
  function del(key) { localStorage.removeItem(key); }

  /* ---------- 密码哈希：优先用浏览器 Web Crypto 做 SHA-256 ---------- */
  async function hash(str) {
    try {
      const buf = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode('sbp::' + str)
      );
      return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      // 非安全上下文（例如用 file:// 打开）时降级：仅做编码，不声称加密
      return 'plain$' + btoa(unescape(encodeURIComponent(str)));
    }
  }

  /* ---------- 用户表 ---------- */
  function users() { return get(K.users, []); }

  /** 首次使用时写入一个演示账号，方便直接登录查看 */
  async function ensureDemo() {
    const list = users();
    if (!list.some(u => u.username === 'demo')) {
      list.push({
        username: 'demo',
        phone: '13800000000',
        pwd: await hash('123456'),
        createdAt: new Date().toISOString()
      });
      set(K.users, list);
    }
  }

  /**
   * 注册
   * @returns {Promise<{ok:boolean,msg:string}>}
   */
  async function register(data) {
    const username = (data.username || '').trim();
    const phone    = (data.phone || '').trim();
    const pwd      = data.password || '';
    const pwd2     = data.password2 || '';

    if (username.length < 3)            return { ok: false, msg: '用户名至少 3 个字符' };
    if (!/^1\d{10}$/.test(phone))       return { ok: false, msg: '手机号格式不正确（应为 11 位数字）' };
    if (pwd.length < 6)                 return { ok: false, msg: '密码至少 6 位' };
    if (pwd !== pwd2)                   return { ok: false, msg: '两次输入的密码不一致' };

    const list = users();
    if (list.some(u => u.username === username)) return { ok: false, msg: '该用户名已被注册' };
    if (list.some(u => u.phone === phone))       return { ok: false, msg: '该手机号已被注册' };

    list.push({
      username, phone,
      pwd: await hash(pwd),
      createdAt: new Date().toISOString()
    });
    set(K.users, list);
    return { ok: true, msg: '注册成功' };
  }

  /** 登录 */
  async function login(username, password, remember) {
    username = (username || '').trim();
    const list = users();
    const user = list.find(u => u.username === username);
    if (!user) return { ok: false, msg: '账号不存在，请先注册' };

    const h = await hash(password);
    if (h !== user.pwd) return { ok: false, msg: '密码错误' };

    set(K.session, { username: user.username, loginAt: Date.now() });

    if (remember) set(K.remember, { username, password });
    else del(K.remember);

    return { ok: true, msg: '登录成功', user };
  }

  function logout() {
    del(K.session);
    location.href = 'login.html';
  }

  function currentUser() { return get(K.session); }
  function remembered()  { return get(K.remember); }

  /* ---------- 导航栏用户信息 ---------- */
  function renderNav() {
    const box = document.getElementById('navUser');
    if (!box) return;
    const me = currentUser();
    if (me) {
      box.innerHTML =
        '当前用户：<b style="color:#fff;border:none">' + esc(me.username) + '</b>' +
        '<button type="button" id="btnLogout">退出</button>';
      const btn = document.getElementById('btnLogout');
      if (btn) btn.onclick = logout;
    } else {
      box.innerHTML = '<span style="opacity:.8">未登录</span>';
    }
  }

  /* ---------- 小工具 ---------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function today() {
    const d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  function hhmmss(ts) {
    const d = new Date(ts);
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(n => String(n).padStart(2, '0')).join(':');
  }

  /* ---------- 手绘 Canvas 折线图（不依赖任何图表库） ---------- */
  /**
   * @param {HTMLCanvasElement} cv
   * @param {Array<{t:number,v:number}>} series 时间序列
   * @param {object} opt {color, min, max, unit, warn}
   */
  function lineChart(cv, series, opt) {
    opt = opt || {};
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 600, h = cv.clientHeight || 200;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const padL = 40, padR = 12, padT = 12, padB = 24;
    const color = opt.color || '#2d8a2d';
    const unit  = opt.unit || '';

    if (!series.length) {
      g.fillStyle = '#90a096'; g.font = '13px 微软雅黑';
      g.textAlign = 'center';
      g.fillText('暂无数据', w / 2, h / 2);
      return;
    }
    const vals = series.map(p => p.v);
    let min = opt.min !== undefined ? opt.min : Math.min.apply(null, vals);
    let max = opt.max !== undefined ? opt.max : Math.max.apply(null, vals);
    if (max - min < 1) { max += 1; min -= 1; }
    const span = max - min;
    min -= span * 0.12; max += span * 0.12;

    const X = i => padL + (w - padL - padR) * (series.length === 1 ? .5 : i / (series.length - 1));
    const Y = v => padT + (h - padT - padB) * (1 - (v - min) / (max - min));

    // 网格与刻度
    g.font = '11px 微软雅黑'; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = min + (max - min) * i / 4;
      const y = Y(v);
      g.strokeStyle = '#e8efe9'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(padL, y); g.lineTo(w - padR, y); g.stroke();
      g.fillStyle = '#8b9a90';
      g.fillText(v.toFixed(1) + unit, padL - 6, y);
    }
    // 告警线
    if (opt.warn !== undefined && opt.warn > min && opt.warn < max) {
      const y = Y(opt.warn);
      g.strokeStyle = '#d64545'; g.setLineDash([5, 4]); g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(padL, y); g.lineTo(w - padR, y); g.stroke();
      g.setLineDash([]);
    }
    // 面积
    g.beginPath();
    g.moveTo(X(0), Y(series[0].v));
    series.forEach((p, i) => g.lineTo(X(i), Y(p.v)));
    g.lineTo(X(series.length - 1), h - padB);
    g.lineTo(X(0), h - padB);
    g.closePath();
    const grad = g.createLinearGradient(0, padT, 0, h - padB);
    grad.addColorStop(0, color + '33');
    grad.addColorStop(1, color + '05');
    g.fillStyle = grad; g.fill();
    // 折线
    g.beginPath();
    series.forEach((p, i) => i ? g.lineTo(X(i), Y(p.v)) : g.moveTo(X(i), Y(p.v)));
    g.strokeStyle = color; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
    // 末点
    const last = series[series.length - 1];
    g.beginPath(); g.arc(X(series.length - 1), Y(last.v), 3.5, 0, Math.PI * 2);
    g.fillStyle = color; g.fill();
    // 时间轴
    g.fillStyle = '#8b9a90'; g.font = '11px 微软雅黑'; g.textBaseline = 'top';
    g.textAlign = 'left';
    g.fillText(hhmmss(series[0].t), padL, h - padB + 5);
    g.textAlign = 'right';
    g.fillText(hhmmss(last.t), w - padR, h - padB + 5);
  }

  /* ---------- 手绘 Canvas 柱状图 ---------- */
  /**
   * @param {Array<{label:string,value:number}>} data
   */
  function barChart(cv, data, opt) {
    opt = opt || {};
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 600, h = cv.clientHeight || 200;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    if (!data.length) {
      g.fillStyle = '#90a096'; g.font = '13px 微软雅黑'; g.textAlign = 'center';
      g.fillText('暂无数据', w / 2, h / 2);
      return;
    }
    const padL = 40, padR = 12, padT = 14, padB = 26;
    const max = Math.max.apply(null, data.map(d => Math.abs(d.value))) || 1;
    const bw  = (w - padL - padR) / data.length;
    const color = opt.color || '#37a237';

    g.font = '11px 微软雅黑'; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = max * i / 4, y = padT + (h - padT - padB) * (1 - i / 4);
      g.strokeStyle = '#e8efe9'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(padL, y); g.lineTo(w - padR, y); g.stroke();
      g.fillStyle = '#8b9a90'; g.fillText(Math.round(v), padL - 6, y);
    }
    data.forEach((d, i) => {
      const bh = (h - padT - padB) * (d.value / max);
      const x = padL + bw * i + bw * 0.22;
      const bwidth = bw * 0.56;
      const y = h - padB - bh;
      const grad = g.createLinearGradient(0, y, 0, h - padB);
      grad.addColorStop(0, color);
      grad.addColorStop(1, color + '99');
      g.fillStyle = grad;
      g.fillRect(x, y, bwidth, bh);
      g.fillStyle = '#40504a'; g.textAlign = 'center'; g.textBaseline = 'bottom';
      g.font = '11px 微软雅黑';
      g.fillText(d.value, x + bwidth / 2, y - 2);
      g.fillStyle = '#6d7d73'; g.textBaseline = 'top';
      g.fillText(d.label, x + bwidth / 2, h - padB + 6);
    });
  }

  /* ---------- 页面加载即执行 ---------- */
  document.addEventListener('DOMContentLoaded', async function () {
    await ensureDemo();
    renderNav();
  });

  return {
    get, set, del, hash, esc, today,
    register, login, logout,
    currentUser, remembered, users,
    renderNav, lineChart, barChart
  };
})();
