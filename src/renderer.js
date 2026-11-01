const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
let hosts = [], active = null, sel = null
const st = {}, live = {}, timers = {}, tabs = new Map(), bySid = new Map(), userStopped = new Set(), crashed = new Set(), retry = {}
const store = (k, v) => { try { v === undefined ? (v = JSON.parse(localStorage.getItem(k))) : localStorage.setItem(k, JSON.stringify(v)) } catch {} return v }
const cache = store('rc-cache') || {}, openHosts = new Set(store('rc-open') || [])
const msg = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
function toast(t, bad = true) {
  const d = document.createElement('div')
  d.className = 'toast' + (bad ? ' bad' : ''); d.textContent = msg(t)
  $('#toasts').append(d); setTimeout(() => d.remove(), 6000)
}

function form(title, fields, v = {}) {
  const m = $('#modal')
  const inp = ([k, , ph, type, opts]) => type === 'select'
    ? `<select name="${k}">${opts.map(o => `<option ${(v[k] || opts[0]) === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
    : `<input name="${k}" type="${type || 'text'}" value="${type === 'password' ? '' : esc(v[k])}" placeholder="${esc(ph || '')}">`
  m.innerHTML = `<form><b>${esc(title)}</b>${fields.map(f => `<label ${f[5] ? `data-show="${f[5]}"` : ''}>${esc(f[1])}${inp(f)}</label>`).join('')}<div class="btns"><button type="button" id="cancel">Cancel</button><button class="pri">Save</button></div></form>`
  const sync = () => { const a = m.querySelector('[name=auth]')?.value; m.querySelectorAll('[data-show]').forEach(l => l.hidden = l.dataset.show !== a) }
  m.querySelector('[name=auth]')?.addEventListener('change', sync); sync()
  m.hidden = false
  m.querySelector('input').focus()
  return new Promise(res => {
    m.querySelector('#cancel').onclick = () => { m.hidden = true; res(null) }
    m.querySelector('form').onsubmit = e => { e.preventDefault(); m.hidden = true; res(Object.fromEntries(new FormData(e.target))) }
  })
}

const order = store('rc-order') || {}
let sortMode = store('rc-sort') || 'az'
const nat = (a, b) => a.localeCompare(b, undefined, { numeric: true })
const consolesOf = h => {
  const defs = h.consoles || [], run = Object.keys((st[h.id] || cache[h.id])?.consoles || {})
  const all = [...defs.map(d => d.name), ...run.filter(n => !defs.some(d => d.name === n))]
  if (sortMode === 'az') return all.sort(nat)
  const o = order[h.id] || [], ix = n => { const i = o.indexOf(n); return i < 0 ? 1e9 : i }
  return all.sort((a, b) => ix(a) - ix(b) || nat(a, b))
}
const defOf = (h, n) => (h.consoles || []).find(d => d.name === n) || { name: n }
const col = new Set(store('rc-col') || [])
const groupOf = (h, n) => defOf(h, n).group || (h.groups || []).find(g => { try { return g.match && new RegExp(g.match).test(n) } catch { return false } })?.name || ''
const saved = h => h.hasSecret ? 'saved, leave empty to keep' : ''
const hostForm = (t, h = {}) => form(t, [['name', 'Name', 'my server'], ['host', 'Address', 'example.com'], ['port', 'Port', '22'], ['user', 'User', 'root'],
  ['auth', 'Login with', '', 'select', ['key', 'password', 'agent']], ['key', 'Private key file', 'empty = ~/.ssh/id_ed25519', 'text', 0, 'key'],
  ['passphrase', 'Key passphrase', saved(h) || 'only if the key has one', 'password', 0, 'key'], ['password', 'Password', saved(h), 'password', 0, 'password']], h)
const consoleForm = (t, d = {}) => form(t, [['name', 'Name', 'survival'], ['group', 'Group', 'optional'], ['dir', 'Folder', '~/server'], ['cmd', 'Start command', './start.sh'], ['stop', 'Stop command', 'stop']], d)
const groupForm = (t, g = {}) => form(t, [['name', 'Name (empty = delete)', 'survival'], ['match', 'Consoles matching (regex)', '^survival\\d+$'], ['panel', 'Panel command', 'cd ~/server && ./manage.sh']], g)
const hostOf = id => hosts.find(h => h.id === id)

function renderSide() {
  const q = $('#q').value.trim().toLowerCase()
  $('#tree').innerHTML = hosts.map(h => {
    const on = live[h.id], wait = on === 'wait', cls = on === true ? 'ok' : on === false ? 'bad' : wait ? 'warn pulse' : ''
    const stale = on !== true, show = on === true || (wait && cache[h.id])
    const data = st[h.id] || cache[h.id], item = n => {
      const run = data?.consoles[n], k = h.id + ':' + n
      return `<div class="item ${sel === k ? 'on' : ''} ${stale ? 'stale' : ''}" draggable="true" data-h="${h.id}" data-n="${esc(n)}"><span class="dot ${stale ? '' : run ? 'ok' : 'bad'}"></span>${esc(n)}${crashed.has(k) ? '<span class="badge">crashed</span>' : ''}</div>`
    }
    const by = {}
    for (const n of consolesOf(h).filter(n => !q || n.toLowerCase().includes(q))) (by[groupOf(h, n)] ||= []).push(n)
    const gs = [...new Set([...(h.groups || []).map(g => g.name), ...Object.keys(by).filter(Boolean)])]
    const head = g => {
      const k = h.id + '/' + g, list = by[g] || [], def = (h.groups || []).find(x => x.name === g)
      if (q && !list.length) return ''
      return `<div class="group" data-g="${esc(g)}" data-gh="${h.id}"><span class="caret">${col.has(k) ? '▸' : '▾'}</span>${esc(g)}<span class="cnt">${list.filter(n => data?.consoles[n]).length}/${list.length}</span>${def?.panel ? '<span class="sm" data-panel="1">panel</span>' : ''}${def ? '<span class="sm" data-gedit="1">edit</span>' : ''}</div>` + (col.has(k) && !q ? '' : list.map(item).join(''))
    }
    const items = show ? [gs.map(head).join(''), ...(by[''] || []).map(item), `<div class="item ${sel === h.id + ':' ? 'on' : ''} ${stale ? 'stale' : ''}" data-h="${h.id}" data-n=""><span class="dot"></span>shell</div>`,
    `<div class="item ${active === 'files:' + h.id ? 'on' : ''} ${stale ? 'stale' : ''}" data-files="${h.id}"><span class="dot"></span>files</div>`,
    `<div class="item muted" data-add="${h.id}">+ console</div><div class="item muted" data-addg="${h.id}">+ group</div>`].join('') : ''
    const note = (wait ? `<span class="sm">${retry[h.id] ? `retry ${retry[h.id]}/3` : 'connecting…'}</span>` : on === false ? '<span class="sm">offline</span>' : '') + `<span class="sm" data-edit="${h.id}">edit</span>`
    return `<div class="host" data-host="${h.id}"><span class="dot ${cls}"></span>${esc(h.name)}${note}</div>${items}`
  }).join('') + `<div class="item muted" id="addhost">+ host</div>`
}

function renderInfo() {
  const box = $('#info')
  if (!sel) return box.innerHTML = ''
  const [id, n] = sel.split(/:(.*)/), h = hostOf(id), c = st[id]?.consoles[n]
  if (!n) return box.innerHTML = `<b>${esc(h.name)} shell</b><button class="pri" data-a="open">Open shell</button>`
  const up = c ? Math.floor(Date.now() / 1000 - c.created) : 0, focused = document.activeElement?.id === 'cmd', typed = $('#cmd')?.value || ''
  const sec = (k, t, body) => `<details data-sec="${k}" ${closed.has(k) ? '' : 'open'}><summary>${t}</summary><div>${body}</div></details>`
  box.innerHTML = `<b>${esc(n)}</b>` +
  sec('stats', 'Stats', `<div class="card"><span>Status</span><b style="color:var(--${c ? 'ok' : 'bad'})">${c ? 'Running' : 'Stopped'}</b></div>
  <div class="card"><span>CPU · RAM</span><b>${c ? `${c.cpu}% · ${c.ram} MB` : '-'}</b></div>
  <div class="card"><span>Uptime</span><b>${c ? `${Math.floor(up / 3600)}h ${Math.floor(up / 60) % 60}m` : '-'}</b></div>`) +
  sec('actions', 'Actions', `<div class="btns"><button class="pri" data-a="open">Console</button><button data-a="${c ? 'stop' : 'start'}">${c ? 'Stop' : 'Start'}</button>
  <button data-a="restart">Restart</button><button data-a="kill">Kill</button><button data-a="edit">Edit</button><button data-a="remove">Remove</button></div>`) +
  sec('send', 'Send command', `<input id="cmd" placeholder="command to send">`) +
  sec('quick', 'Quick commands', `<div class="quick">${(h.quick || []).map((q, i) => `<button data-q="${i}" title="${esc(q)}">${esc(q)}<span class="sm" data-qx="${i}">x</span></button>`).join('')}<button class="muted" data-q="add">+ quick command</button></div>`)
  const ci = $('#cmd'); if (ci) { ci.value = typed; if (focused) ci.focus() }
}

function renderFoot() {
  const id = sel?.split(':')[0] || hosts.find(x => live[x.id] === true)?.id, h = id && st[id]?.host
  $('#foot').innerHTML = h ? `<span>${esc(hostOf(id).name)} · ${esc(hostOf(id).host)}</span><span>CPU ${h.cpu}%</span><span>RAM ${(h.used / 1024).toFixed(1)} / ${(h.total / 1024).toFixed(1)} GB</span><span>Disk ${esc(h.disk)}</span>` : ''
}
function renderTabs() {
  for (const [k, t] of tabs) {
    const [id, n] = k.split(/:(.*)/), d = t.tab.querySelector('.dot')
    if (d && !t.panel) d.className = 'dot ' + (!n ? '' : st[id]?.consoles[n] ? 'ok' : 'bad')
  }
}
const render = () => { renderSide(); renderInfo(); renderFoot(); renderTabs() }

async function poll(id) {
  try {
    const prev = st[id]?.consoles || {}
    st[id] = await api.stats(id)
    live[id] = true
    cache[id] = { consoles: st[id].consoles }; store('rc-cache', cache)
    for (const d of hostOf(id)?.consoles || []) {
      const k = id + ':' + d.name
      if (st[id].consoles[d.name]) crashed.delete(k)
      if (prev[d.name] && !st[id].consoles[d.name] && !userStopped.delete(k) && crashed.add(k))
        new Notification('RoyalConsole', { body: `${d.name} on ${hostOf(id).name} stopped` })
    }
  } catch (e) {
    if (live[id] === true) { toast(`${hostOf(id).name}: connection lost, reconnecting`); clearInterval(timers[id]); delete timers[id]; return connectHost(id) }
  }
  render()
}

async function connectHost(id) {
  if (live[id] === 'wait') return
  live[id] = 'wait'; delete retry[id]; openHosts.add(id); store('rc-open', [...openHosts]); render()
  try {
    await api.connect(id); live[id] = true; delete retry[id]
    await poll(id); timers[id] = setInterval(() => poll(id), 3000)
  } catch (e) { live[id] = false; delete retry[id]; render(); toast(`${hostOf(id)?.name}: ${msg(e)}`) }
}

function toggleHost(id) {
  if (live[id] === 'wait') return
  if (live[id] !== true) return connectHost(id)
  clearInterval(timers[id]); delete timers[id]; delete live[id]; delete st[id]
  openHosts.delete(id); store('rc-open', [...openHosts]); api.disconnect(id); render()
}

function activate(k) {
  active = k
  for (const [key, t] of tabs) { t.el.hidden = key !== k; t.tab.classList.toggle('on', key === k) }
  $('#empty').hidden = tabs.size > 0
  const t = tabs.get(k)
  if (t) { if (!t.files && !t.panel) sel = k; t.fit.fit(); t.term.focus() }
  render()
}

function closeTab(k) {
  const t = tabs.get(k)
  if (!t) return
  api.close(t.sid); t.term.dispose(); t.el.remove(); t.tab.remove(); tabs.delete(k)
  activate([...tabs.keys()].pop() || null)
}

async function openTab(id, n, o = {}) {
  const k = o.key || id + ':' + n
  if (tabs.has(k)) return activate(k)
  const el = document.createElement('div'), tab = document.createElement('div')
  el.className = 'term'; $('#terms').append(el)
  tab.className = 'tab'; tab.innerHTML = `<span class="dot"></span>${esc(hostOf(id).name)} / ${esc(o.title || n || 'shell')} <span class="sm">x</span>`
  tab.onclick = e => e.target.classList.contains('sm') ? closeTab(k) : activate(k)
  $('#tabs').append(tab)
  const term = new Terminal({ fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 13, scrollback: 10000, theme: { background: '#14161a' } })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(fit); term.open(el)
  term.attachCustomKeyEventHandler(e => !(e.ctrlKey && /^[1-9]$/.test(e.key)))
  const t = { el, tab, term, fit, sid: 0, panel: !!o.cmd }
  tabs.set(k, t); activate(k)
  term.write('\x1b[90mconnecting…\x1b[0m\r\n')
  try { t.sid = await api.open(id, o.cmd ? { cmd: o.cmd } : n || null, term.cols, term.rows) } catch (e) { term.write(`\x1b[31m${msg(e)}\x1b[0m\r\n`); return }
  bySid.set(t.sid, t)
  term.onData(d => api.write(t.sid, d))
  term.onResize(({ cols, rows }) => api.resize(t.sid, cols, rows))
}

const TXT = /\.(ya?ml|json|txt|properties|sh|log|php|conf|cfg|toml|ini|md)$/i
const fsize = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'
async function openFiles(id) {
  const k = 'files:' + id
  if (tabs.has(k)) return activate(k)
  const el = document.createElement('div'), tab = document.createElement('div'), F = (op, ...a) => api.fs(id, op, ...a)
  el.className = 'term fb'; $('#terms').append(el)
  tab.className = 'tab'; tab.innerHTML = `${esc(hostOf(id).name)} / files <span class="sm">x</span>`
  tab.onclick = e => e.target.classList.contains('sm') ? closeTab(k) : activate(k)
  $('#tabs').append(tab)
  const t = { el, tab, files: true, sid: 0, fit: { fit() {} }, term: { dispose() {}, focus() {} } }
  tabs.set(k, t); activate(k)
  let cwd = await F('home'), list = []
  const full = n => (cwd === '/' ? '' : cwd) + '/' + n
  const fail = e => toast(e.message || e)
  async function ls(d = cwd) {
    try { list = await F('ls', d); cwd = d } catch (e) { return fail(e) }
    list.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name))
    el.innerHTML = `<div class="fbar"><button data-f="up">Up</button><input class="fpath" value="${esc(cwd)}"><button data-f="ref">Refresh</button></div>
    <div class="flist">${list.map((f, i) => `<div class="frow" data-i="${i}"><span>${f.dir ? '📁' : '📄'} ${esc(f.name)}</span><span class="muted">${f.dir ? '' : fsize(f.size)}</span><span class="muted">${new Date(f.mtime * 1000).toLocaleString()}</span><span class="fact">${f.dir ? '' : '<b data-f="dl">download</b>'}<b data-f="mv">rename</b><b data-f="rm">delete</b></span></div>`).join('') || '<div class="muted" style="padding:10px">empty</div>'}</div>`
  }
  async function edit(f) {
    const p = full(f.name)
    if (f.size > 5 << 20) return toast('File too large')
    let txt
    try { txt = await F('read', p) } catch (e) { return fail(e) }
    el.innerHTML = `<div class="fbar"><button data-f="back">Back</button><b class="fpath">${esc(p)}</b><span class="ferr"></span><button class="pri" data-f="save">Save</button></div><textarea class="fedit" spellcheck="false"></textarea>`
    const ta = el.querySelector('textarea'), err = el.querySelector('.ferr')
    ta.value = txt; ta.focus()
    const save = async () => {
      err.textContent = 'saving...'
      try { const r = await F('write', p, ta.value); err.textContent = r?.err || 'saved'; err.classList.toggle('bad', !!r?.err) } catch (e) { err.textContent = e.message; err.classList.add('bad') }
    }
    ta.onkeydown = e => {
      if (e.ctrlKey && e.key === 's') { e.preventDefault(); save() }
      if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end') }
    }
    el.querySelector('[data-f=save]').onclick = save
    el.querySelector('[data-f=back]').onclick = () => ls()
  }
  el.onclick = async e => {
    const a = e.target.dataset.f, f = list[e.target.closest('[data-i]')?.dataset.i]
    if (a === 'up') ls(cwd.replace(/\/[^/]*$/, '') || '/')
    if (a === 'ref') ls()
    if (a === 'dl') F('download', full(f.name)).catch(fail)
    if (a === 'mv') {
      const v = await form('Rename', [['name', 'Name']], f)
      if (v?.name && v.name !== f.name) await F('rename', full(f.name), full(v.name)).catch(fail), ls()
    }
    if (a === 'rm' && confirm(`Delete ${full(f.name)}?`)) await F('rm', full(f.name)).catch(fail), ls()
  }
  el.ondblclick = e => {
    const f = list[e.target.closest('[data-i]')?.dataset.i]
    if (!f || e.target.dataset.f) return
    f.dir ? ls(full(f.name)) : TXT.test(f.name) ? edit(f) : toast('Not a text file')
  }
  el.onkeydown = e => { if (e.key === 'Enter' && e.target.classList.contains('fpath')) ls(e.target.value) }
  el.ondragover = e => { e.preventDefault(); el.classList.add('drop') }
  el.ondragleave = () => el.classList.remove('drop')
  el.ondrop = async e => {
    e.preventDefault(); el.classList.remove('drop')
    if (!el.querySelector('.flist')) return
    await F('upload', cwd, [...e.dataTransfer.files].map(api.pathOf)).catch(fail); ls()
  }
  ls()
}

async function act(a) {
  const [id, n] = sel.split(/:(.*)/), h = hostOf(id), d = defOf(h, n)
  if (a === 'open') return openTab(id, n)
  if (a === 'edit' || a === 'remove') {
    h.consoles = (h.consoles || []).filter(x => x.name !== n)
    if (a === 'edit') {
      const v = await consoleForm('Console', d)
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
  try {
    const r = await api.action(id, a, d)
    r.code ? toast(r.out || 'failed') : toast(`${n}: ${a} sent`, false)
  } catch (e) { toast(e) }
  poll(id)
}

$('#side').onclick = async e => {
  const x = e.target.closest('[data-panel],[data-gedit],[data-edit],[data-host],[data-addg],[data-add],[data-files],[data-g],[data-n],#addhost')
  if (!x) return
  const gr = x.closest('.group'), gh = gr && hostOf(gr.dataset.gh), gname = gr?.dataset.g
  if (x.dataset.panel) { const g = gh.groups.find(y => y.name === gname); return openTab(gh.id, '', { key: 'panel:' + gh.id + ':' + gname, title: gname + ' panel', cmd: g.panel }) }
  if (x.dataset.gedit) {
    const g = gh.groups.find(y => y.name === gname), v = await groupForm('Group', g)
    if (v) { v.name ? Object.assign(g, v) : gh.groups.splice(gh.groups.indexOf(g), 1); await api.saveHost(gh) }
    return render()
  }
  if (x.dataset.addg) {
    const h = hostOf(x.dataset.addg), v = await groupForm('New group')
    if (v?.name) (h.groups ||= []).push(v), await api.saveHost(h)
    return render()
  }
  if (x === gr) {
    const k = gh.id + '/' + gname
    col.has(k) ? col.delete(k) : col.add(k); store('rc-col', [...col]); return renderSide()
  }
  if (x.dataset.edit) {
    e.stopPropagation()
    const h = hostOf(x.dataset.edit)
    const v = await hostForm('Host', h)
    if (v) Object.assign(h, await api.saveHost({ ...h, ...v }))
    return render()
  }
  if (x.id === 'addhost') {
    const v = await hostForm('New host')
    if (v) hosts.push(await api.saveHost(v))
    return render()
  }
  if (x.dataset.files) return openFiles(x.dataset.files)
  if (x.dataset.host) return toggleHost(x.dataset.host)
  if (x.dataset.add) {
    const h = hostOf(x.dataset.add)
    const v = await consoleForm('New console')
    if (v) (h.consoles ||= []).push(v), await api.saveHost(h)
    return render()
  }
  sel = x.dataset.h + ':' + x.dataset.n
  crashed.delete(sel)
  openTab(x.dataset.h, x.dataset.n)
}
$('#info').onclick = async e => {
  const { a, q, qx } = e.target.dataset
  if (a) return act(a)
  const [id, n] = sel.split(/:(.*)/), h = hostOf(id)
  if (qx) { h.quick.splice(qx, 1); await api.saveHost(h); return render() }
  if (q === 'add') {
    const v = await form('Quick command', [['text', 'Command', 'say restart in 5 min']])
    if (v?.text) (h.quick ||= []).push(v.text), await api.saveHost(h)
    return render()
  }
  if (q) api.action(id, 'send', { name: n, text: h.quick[q] })
}
$('#bc').onclick = () => {
  const on = hosts.filter(h => live[h.id] === true)
  if (!on.length) return toast('Connect to a host first')
  const hist = store('rc-bc') || [], picked = new Set(store('rc-bc-sel') || [])
  const rows = on.map(h => {
    const by = {}
    for (const n of consolesOf(h).filter(n => st[h.id]?.consoles[n])) (by[groupOf(h, n)] ||= []).push(n)
    const cb = (cls, attrs, label, chk) => `<label class="${cls}"><input type="checkbox" ${attrs} ${chk ? 'checked' : ''}>${label}</label>`
    return cb('lh', `data-lh="${h.id}"`, esc(h.name)) + Object.entries(by).map(([g, list]) =>
      (g ? cb('lg', `data-lg="${h.id}/${esc(g)}"`, esc(g)) : '') + list.map(n => cb('lc', `data-c="${h.id}" data-g="${h.id}/${esc(g)}" value="${esc(n)}"`, esc(n), picked.has(h.id + ':' + n))).join('')).join('')
  }).join('')
  const m = $('#modal')
  m.innerHTML = `<div class="bc"><b>Broadcast</b>
    <label>Command<input id="bct" list="bch" placeholder="say Restart in 5 minutes"><datalist id="bch">${hist.map(x => `<option value="${esc(x)}">`).join('')}</datalist></label>
    <div class="row"><button type="button" data-s="all">All</button><button type="button" data-s="none">None</button><span class="muted" id="bcn"></span><label class="row" style="margin-left:auto">Delay (s)<input id="bcd" type="number" min="0" value="0" style="width:70px"></label></div>
    <div class="bcl">${rows || '<div class="muted">No running consoles</div>'}</div>
    <div class="btns"><button type="button" id="bcx">Cancel</button><button class="pri" id="bcs">Send</button></div></div>`
  m.hidden = false; $('#bct').focus()
  const boxes = () => [...m.querySelectorAll('input[data-c]')]
  const sync = () => {
    for (const g of m.querySelectorAll('[data-lg]')) { const b = boxes().filter(x => x.dataset.g === g.dataset.lg); g.checked = b.every(x => x.checked); g.indeterminate = !g.checked && b.some(x => x.checked) }
    for (const h of m.querySelectorAll('[data-lh]')) { const b = boxes().filter(x => x.dataset.c === h.dataset.lh); h.checked = b.length && b.every(x => x.checked); h.indeterminate = !h.checked && b.some(x => x.checked) }
    $('#bcn').textContent = boxes().filter(x => x.checked).length + ' selected'
  }
  m.onchange = e => {
    const t = e.target
    if (t.dataset.lh) boxes().filter(x => x.dataset.c === t.dataset.lh).forEach(x => x.checked = t.checked)
    if (t.dataset.lg) boxes().filter(x => x.dataset.g === t.dataset.lg).forEach(x => x.checked = t.checked)
    sync()
  }
  m.onclick = async e => {
    const s = e.target.dataset.s
    if (s) { boxes().forEach(x => x.checked = s === 'all'); return sync() }
    if (e.target.id === 'bcx') { m.hidden = true; m.onclick = m.onchange = null }
    if (e.target.id !== 'bcs') return
    const text = $('#bct').value.trim(), to = boxes().filter(x => x.checked).map(x => [x.dataset.c, x.value]), delay = Math.max(0, +$('#bcd').value || 0)
    if (!text) return toast('Type a command')
    if (!to.length) return toast('Pick at least one console')
    store('rc-bc', [text, ...hist.filter(x => x !== text)].slice(0, 15)); store('rc-bc-sel', to.map(([i, n]) => i + ':' + n))
    m.hidden = true; m.onclick = m.onchange = null
    let ok = 0
    for (const [i, name] of to) {
      try { await api.action(i, 'send', { name, text }); ok++ } catch (err) { toast(`${name}: ${msg(err)}`) }
      if (delay) await new Promise(r => setTimeout(r, delay * 1000))
    }
    toast(`Sent to ${ok}/${to.length} console(s)`, ok !== to.length)
  }
  sync()
}
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
api.on('host-closed', id => { if (live[id] !== true) return; clearInterval(timers[id]); delete timers[id]; toast(`${hostOf(id).name}: connection lost, reconnecting`); connectHost(id) })
api.on('host-retry', (id, n) => { retry[id] = n; render() })

$('#q').oninput = renderSide
const closed = new Set(store('rc-closed') || [])
$('#info').addEventListener('toggle', e => { const k = e.target.dataset?.sec; if (!k) return; e.target.open ? closed.delete(k) : closed.add(k); store('rc-closed', [...closed]) }, true)
const W = store('rc-w') || { side: 220, info: 220 }, ui = store('rc-ui') || {}
const applyUi = () => {
  $('#side').style.width = W.side + 'px'; $('#info').style.width = W.info + 'px'
  document.body.classList.toggle('noside', !!ui.noside); document.body.classList.toggle('noinfo', !!ui.noinfo)
  $('#tside').classList.toggle('on', !ui.noside); $('#tinfo').classList.toggle('on', !ui.noinfo); $('#sort').textContent = sortMode === 'az' ? 'A-Z' : 'Custom'
  requestAnimationFrame(() => tabs.get(active)?.fit.fit())
}
$('#tside').onclick = () => { ui.noside = !ui.noside; store('rc-ui', ui); applyUi() }
$('#tinfo').onclick = () => { ui.noinfo = !ui.noinfo; store('rc-ui', ui); applyUi() }
$('#sort').onclick = () => { sortMode = sortMode === 'az' ? 'custom' : 'az'; store('rc-sort', sortMode); applyUi(); renderSide() }
document.querySelectorAll('.split').forEach(s => s.onmousedown = e => {
  e.preventDefault(); s.classList.add('drag'); document.body.classList.add('dragging')
  const move = ev => {
    W[s.dataset.for] = Math.min(600, Math.max(140, s.dataset.for === 'side' ? ev.clientX - $('#side').getBoundingClientRect().left : window.innerWidth - ev.clientX))
    applyUi()
  }
  const up = () => { s.classList.remove('drag'); document.body.classList.remove('dragging'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); store('rc-w', W) }
  addEventListener('mousemove', move); addEventListener('mouseup', up)
})
let drag = null
$('#tree').addEventListener('dragstart', e => { const x = e.target.closest('[data-n][draggable]'); drag = x && { h: x.dataset.h, n: x.dataset.n }; e.dataTransfer.effectAllowed = 'move' })
$('#tree').addEventListener('dragover', e => {
  const x = e.target.closest('[data-n][draggable]')
  document.querySelectorAll('.dragover').forEach(y => y !== x && y.classList.remove('dragover'))
  if (drag && x && x.dataset.h === drag.h) { e.preventDefault(); x.classList.add('dragover') }
})
$('#tree').addEventListener('drop', e => {
  const x = e.target.closest('[data-n][draggable]')
  if (!drag || !x || x.dataset.h !== drag.h || x.dataset.n === drag.n) return
  e.preventDefault()
  const h = hostOf(drag.h), list = consolesOf(h).filter(n => n !== drag.n)
  list.splice(list.indexOf(x.dataset.n), 0, drag.n)
  order[h.id] = list; store('rc-order', order); sortMode = 'custom'; store('rc-sort', sortMode); applyUi(); renderSide()
})
$('#tree').addEventListener('dragend', () => { drag = null; document.querySelectorAll('.dragover').forEach(y => y.classList.remove('dragover')) })
applyUi()
api.hosts().then(h => { hosts = h; render(); h.filter(x => openHosts.has(x.id)).forEach(x => connectHost(x.id)) })
