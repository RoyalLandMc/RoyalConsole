const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
let hosts = [], active = null, sel = null
const st = {}, live = {}, timers = {}, tabs = new Map(), bySid = new Map(), userStopped = new Set()

function form(title, fields, v = {}) {
  const m = $('#modal')
  m.innerHTML = `<form><b>${esc(title)}</b>${fields.map(([k, l, ph]) => `<label>${esc(l)}<input name="${k}" value="${esc(v[k])}" placeholder="${esc(ph || '')}"></label>`).join('')}<div class="btns"><button type="button" id="cancel">Cancel</button><button class="pri">Save</button></div></form>`
  m.hidden = false
  m.querySelector('input').focus()
  return new Promise(res => {
    m.querySelector('#cancel').onclick = () => { m.hidden = true; res(null) }
    m.querySelector('form').onsubmit = e => { e.preventDefault(); m.hidden = true; res(Object.fromEntries(new FormData(e.target))) }
  })
}

const consolesOf = h => {
  const defs = h.consoles || [], run = Object.keys(st[h.id]?.consoles || {})
  return [...defs.map(d => d.name), ...run.filter(n => !defs.some(d => d.name === n))]
}
const defOf = (h, n) => (h.consoles || []).find(d => d.name === n) || { name: n }
const hostOf = id => hosts.find(h => h.id === id)

function renderSide() {
  $('#side').innerHTML = hosts.map(h => {
    const on = live[h.id], cls = on === true ? 'ok' : on === false ? 'bad' : ''
    const items = on ? [...consolesOf(h).map(n => {
      const run = st[h.id]?.consoles[n], k = h.id + ':' + n
      return `<div class="item ${sel === k ? 'on' : ''}" data-h="${h.id}" data-n="${esc(n)}"><span class="dot ${run ? 'ok' : 'bad'}"></span>${esc(n)}</div>`
    }), `<div class="item ${sel === h.id + ':' ? 'on' : ''}" data-h="${h.id}" data-n=""><span class="dot"></span>shell</div>`,
    `<div class="item muted" data-add="${h.id}">+ console</div>`].join('') : ''
    return `<div class="host" data-host="${h.id}"><span class="dot ${cls}"></span>${esc(h.name)}<span class="sm" data-edit="${h.id}">edit</span></div>${items}`
  }).join('') + `<div class="item muted" id="addhost">+ host</div>`
}

function renderInfo() {
  const box = $('#info')
  if (!sel) return box.innerHTML = ''
  const [id, n] = sel.split(/:(.*)/), h = hostOf(id), c = st[id]?.consoles[n]
  if (!n) return box.innerHTML = `<b>${esc(h.name)} shell</b><button class="pri" data-a="open">Open shell</button>`
  const up = c ? Math.floor(Date.now() / 1000 - c.created) : 0
  box.innerHTML = `<b>${esc(n)}</b>
  <div class="card"><span>Status</span><b style="color:var(--${c ? 'ok' : 'bad'})">${c ? 'Running' : 'Stopped'}</b></div>
  <div class="card"><span>CPU · RAM</span><b>${c ? `${c.cpu}% · ${c.ram} MB` : '-'}</b></div>
  <div class="card"><span>Uptime</span><b>${c ? `${Math.floor(up / 3600)}h ${Math.floor(up / 60) % 60}m` : '-'}</b></div>
  <div class="btns"><button class="pri" data-a="open">Console</button><button data-a="${c ? 'stop' : 'start'}">${c ? 'Stop' : 'Start'}</button>
  <button data-a="restart">Restart</button><button data-a="kill">Kill</button><button data-a="edit">Edit</button><button data-a="remove">Remove</button></div>
  <input id="cmd" placeholder="command to send">`
}

function renderFoot() {
  const id = sel?.split(':')[0], h = id && st[id]?.host
  $('#foot').innerHTML = h ? `<span>${esc(hostOf(id).name)} · ${esc(hostOf(id).host)}</span><span>CPU ${h.cpu}%</span><span>RAM ${(h.used / 1024).toFixed(1)} / ${(h.total / 1024).toFixed(1)} GB</span><span>Disk ${esc(h.disk)}</span>` : ''
}
const render = () => { renderSide(); renderInfo(); renderFoot() }

async function poll(id) {
  try {
    const prev = st[id]?.consoles || {}
    st[id] = await api.stats(id)
    live[id] = true
    for (const d of hostOf(id)?.consoles || []) {
      if (prev[d.name] && !st[id].consoles[d.name] && !userStopped.delete(id + ':' + d.name))
        new Notification('RoyalConsole', { body: `${d.name} on ${hostOf(id).name} stopped` })
    }
  } catch { live[id] = false; clearInterval(timers[id]); delete timers[id] }
  render()
}

async function toggleHost(id) {
  if (timers[id]) { clearInterval(timers[id]); delete timers[id]; delete live[id]; return render() }
  try { await api.connect(id); live[id] = true; await poll(id); timers[id] = setInterval(() => poll(id), 3000) }
  catch (e) { live[id] = false; render(); alert(e.message) }
}

function activate(k) {
  active = k
  for (const [key, t] of tabs) { t.el.hidden = key !== k; t.tab.classList.toggle('on', key === k) }
  $('#empty').hidden = tabs.size > 0
  const t = tabs.get(k)
  if (t) { sel = k; t.fit.fit(); t.term.focus() }
  render()
}

function closeTab(k) {
  const t = tabs.get(k)
  if (!t) return
  api.close(t.sid); t.term.dispose(); t.el.remove(); t.tab.remove(); tabs.delete(k)
  activate([...tabs.keys()].pop() || null)
}

async function openTab(id, n) {
  const k = id + ':' + n
  if (tabs.has(k)) return activate(k)
  const el = document.createElement('div'), tab = document.createElement('div')
  el.className = 'term'; $('#terms').append(el)
  tab.className = 'tab'; tab.innerHTML = `${esc(hostOf(id).name)} / ${esc(n || 'shell')} <span class="sm">x</span>`
  tab.onclick = e => e.target.classList.contains('sm') ? closeTab(k) : activate(k)
  $('#tabs').append(tab)
  const term = new Terminal({ fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 13, scrollback: 10000, theme: { background: '#14161a' } })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(fit); term.open(el)
  term.attachCustomKeyEventHandler(e => !(e.ctrlKey && /^[1-9]$/.test(e.key)))
  const t = { el, tab, term, fit, sid: 0 }
  tabs.set(k, t); activate(k)
  t.sid = await api.open(id, n || null, term.cols, term.rows)
  bySid.set(t.sid, t)
  term.onData(d => api.write(t.sid, d))
  term.onResize(({ cols, rows }) => api.resize(t.sid, cols, rows))
}

async function act(a) {
  const [id, n] = sel.split(/:(.*)/), h = hostOf(id), d = defOf(h, n)
  if (a === 'open') return openTab(id, n)
  if (a === 'edit' || a === 'remove') {
    h.consoles = (h.consoles || []).filter(x => x.name !== n)
    if (a === 'edit') {
      const v = await form('Console', [['name', 'Name'], ['dir', 'Folder', '~/skyblock'], ['cmd', 'Start command', './start.sh'], ['stop', 'Stop command', 'stop']], d)
      if (v) { h.consoles.push(v); sel = id + ':' + v.name } else h.consoles.push(d)
    }
    await api.saveHost(h); return render()
  }
  if (a === 'stop' || a === 'kill' || a === 'restart') userStopped.add(sel)
  if (a === 'restart') {
    await api.action(id, 'stop', d)
    for (let i = 0; i < 30 && (await api.stats(id)).consoles[n]; i++) await new Promise(r => setTimeout(r, 1000))
    await api.action(id, 'kill', d).catch(() => {})
    a = 'start'
  }
  const r = await api.action(id, a, d)
  if (r.code) alert(r.out || 'failed')
  poll(id)
}

$('#side').onclick = async e => {
  const x = e.target.closest('[data-edit],[data-host],[data-add],[data-n],#addhost')
  if (!x) return
  if (x.dataset.edit) {
    e.stopPropagation()
    const h = hostOf(x.dataset.edit)
    const v = await form('Host', [['name', 'Name'], ['host', 'Address'], ['port', 'Port', '22'], ['user', 'User'], ['key', 'Private key', 'empty = ~/.ssh/id_ed25519']], h)
    if (v) Object.assign(h, v), await api.saveHost(h)
    return render()
  }
  if (x.id === 'addhost') {
    const v = await form('New host', [['name', 'Name', 'skyblock vps'], ['host', 'Address', '217.18.90.6'], ['port', 'Port', '22'], ['user', 'User', 'root'], ['key', 'Private key', 'empty = ~/.ssh/id_ed25519']])
    if (v) hosts.push(await api.saveHost(v))
    return render()
  }
  if (x.dataset.host) return toggleHost(x.dataset.host)
  if (x.dataset.add) {
    const h = hostOf(x.dataset.add)
    const v = await form('New console', [['name', 'Name', 'lobby1'], ['dir', 'Folder', '~/skyblock'], ['cmd', 'Start command', './start.sh'], ['stop', 'Stop command', 'stop']])
    if (v) (h.consoles ||= []).push(v), await api.saveHost(h)
    return render()
  }
  sel = x.dataset.h + ':' + x.dataset.n
  tabs.has(sel) ? activate(sel) : render()
}
$('#side').ondblclick = e => { const x = e.target.closest('[data-n]'); if (x) openTab(x.dataset.h, x.dataset.n) }
$('#info').onclick = e => { const a = e.target.dataset.a; if (a) act(a) }
$('#info').onkeydown = async e => {
  if (e.key !== 'Enter' || e.target.id !== 'cmd' || !e.target.value) return
  const [id, n] = sel.split(/:(.*)/)
  await api.action(id, 'send', { name: n, text: e.target.value }); e.target.value = ''
}
document.addEventListener('keydown', e => {
  if (e.ctrlKey && /^[1-9]$/.test(e.key)) { const k = [...tabs.keys()][e.key - 1]; if (k) activate(k) }
})
window.addEventListener('resize', () => tabs.get(active)?.fit.fit())
api.on('data', (sid, d) => bySid.get(sid)?.term.write(d))
api.on('exit', sid => bySid.get(sid)?.term.write('\r\n\x1b[90m[closed]\x1b[0m\r\n'))
api.on('host-closed', id => { live[id] = false; clearInterval(timers[id]); delete timers[id]; render() })

api.hosts().then(h => { hosts = h; render() })
