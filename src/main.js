const { app, BrowserWindow, ipcMain, dialog, safeStorage, clipboard } = require('electron')
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto')
const { Client } = require('ssh2')
const YAML = require('yaml')

let win, seq = 0
const conns = new Map(), streams = new Map()
const cfgFile = () => path.join(app.getPath('userData'), 'hosts.json')
const loadHosts = () => { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) } catch { return [] } }
const saveHosts = h => fs.writeFileSync(cfgFile(), JSON.stringify(h, null, 2))
const send = (...a) => win && !win.isDestroyed() && win.webContents.send(...a)
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`

function updateHost(h) {
  const all = loadHosts(), i = all.findIndex(x => x.id === h.id)
  i < 0 ? all.push(h) : (all[i] = h)
  saveHosts(all)
}

const secretOf = h => { try { return h.secret ? JSON.parse(safeStorage.decryptString(Buffer.from(h.secret, 'base64'))) : {} } catch { return {} } }
const authOf = (h, s) => h.auth === 'password' ? { password: s.password, tryKeyboard: true }
  : h.auth === 'agent' ? { agent: process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK }
  : { privateKey: fs.readFileSync(h.key || path.join(os.homedir(), '.ssh', 'id_ed25519')), passphrase: s.passphrase || undefined }

function dial(h) {
  const sec = secretOf(h)
  return new Promise((res, rej) => {
    const c = new Client()
    let ready = false
    c.on('ready', () => { ready = true; res(c) })
      .on('error', e => { c.end(); rej(e) })
      .on('close', () => { if (ready) { conns.delete(h.id); send('host-closed', h.id) } })
      .on('keyboard-interactive', (n, i, l, p, finish) => finish(p.map(() => sec.password || '')))
    c.connect({
      host: h.host, port: +h.port || 22, username: h.user, ...authOf(h, sec),
      keepaliveInterval: 15000, keepaliveCountMax: 4, readyTimeout: 30000,
      hostVerifier: k => {
        const fp = crypto.createHash('sha256').update(k).digest('base64')
        if (!h.fp) { h.fp = fp; updateHost(h); return true }
        return h.fp === fp
      }
    })
  })
}

function connect(id) {
  if (conns.has(id)) return conns.get(id)
  const h = loadHosts().find(x => x.id === id)
  if (!h) return Promise.reject(new Error('Unknown host'))
  const p = (async () => {
    for (let i = 1; ; i++) {
      try { return await dial(h) } catch (e) {
        if (i >= 3 || /authentication|verification|ENOENT|passphrase|encrypted|agent/i.test(e.message)) { conns.delete(id); throw e }
        send('host-retry', id, i + 1)
        await new Promise(r => setTimeout(r, 1500 * i))
      }
    }
  })()
  conns.set(id, p)
  return p
}

async function run(id, cmd) {
  const c = await connect(id)
  return new Promise((res, rej) => c.exec(cmd, (e, s) => {
    if (e) return rej(e)
    let out = ''
    s.on('data', d => out += d).stderr.on('data', d => out += d)
    s.on('close', code => res({ code, out }))
  }))
}

const STATS = `tmux ls -F '#{session_name} #{session_created} #{pane_pid}' 2>/dev/null | while read n c p; do echo "S $n $c $(ps -o %cpu=,rss= -p $p --ppid $p | awk '{c+=$1;r+=$2}END{printf "%.1f %d",c,r/1024}')"; done
echo "H $(vmstat 1 2 | tail -1 | awk '{print 100-$15}') $(free -m | awk '/Mem/{print $3,$2}') $(df -P / | awk 'NR==2{print $5}')"`

const sftps = new WeakMap()
async function sftp(id) {
  const c = await connect(id)
  if (!sftps.has(c)) sftps.set(c, new Promise((res, rej) => c.sftp((e, s) => e ? (sftps.delete(c), rej(e)) : res(s))))
  return sftps.get(c)
}
const P = (o, m, ...a) => new Promise((res, rej) => o[m](...a, (e, r) => e ? rej(e) : res(r)))
const isDir = m => (m & 0o170000) === 0o040000
const FS = {
  home: s => P(s, 'realpath', '.'),
  ls: async (s, d) => Promise.all((await P(s, 'readdir', d)).map(async f => {
    let a = f.attrs
    if ((a.mode & 0o170000) === 0o120000) a = await P(s, 'stat', path.posix.join(d, f.filename)).catch(() => a)
    return { name: f.filename, dir: isDir(a.mode), size: a.size, mtime: a.mtime }
  })),
  read: (s, f) => P(s, 'readFile', f, 'utf8'),
  write: async (s, f, t) => {
    if (/\.ya?ml$/i.test(f)) try { YAML.parse(t) } catch (e) { return { err: e.message } }
    await P(s, 'writeFile', f, t)
  },
  rename: (s, a, b) => P(s, 'rename', a, b),
  upload: async (s, d, files) => { for (const f of files) if (fs.statSync(f).isFile()) await P(s, 'fastPut', f, path.posix.join(d, path.basename(f))) },
  download: async (s, f) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.posix.basename(f) })
    if (!r.canceled) await P(s, 'fastGet', f, r.filePath)
  }
}
ipcMain.handle('fs', async (_, id, op, ...a) => {
  if (op === 'rm') return run(id, `rm -rf -- ${q(a[0])}`)
  return FS[op](await sftp(id), ...a)
})
const pub = h => { const { secret, ...r } = h; return { ...r, hasSecret: !!secret } }
ipcMain.handle('hosts', () => loadHosts().map(pub))
ipcMain.handle('host-save', (_, h) => {
  h.id ||= crypto.randomUUID()
  const old = loadHosts().find(x => x.id === h.id) || {}, sec = secretOf(old)
  if (h.password) sec.password = h.password
  if (h.passphrase) sec.passphrase = h.passphrase
  delete h.password; delete h.passphrase; delete h.hasSecret
  if (Object.keys(sec).length) h.secret = safeStorage.encryptString(JSON.stringify(sec)).toString('base64')
  if (old.host !== h.host || old.port !== h.port) { delete h.fp; const p = conns.get(h.id); conns.delete(h.id); p?.then(c => c.end()).catch(() => {}) } else h.fp = old.fp
  updateHost(h)
  return pub(h)
})
ipcMain.handle('host-del', (_, id) => { saveHosts(loadHosts().filter(x => x.id !== id)); conns.get(id)?.then(c => c.end()).catch(() => {}) })
ipcMain.handle('connect', async (_, id) => { await connect(id); return true })
ipcMain.handle('disconnect', async (_, id) => { const p = conns.get(id); conns.delete(id); (await p?.catch(() => null))?.end() })
ipcMain.handle('run', (_, id, cmd) => run(id, cmd))

ipcMain.handle('stats', async (_, id) => {
  const { out } = await run(id, STATS), s = { consoles: {}, host: null }
  for (const l of out.split('\n')) {
    const p = l.trim().split(/\s+/)
    if (p[0] === 'S') s.consoles[p[1]] = { created: +p[2], cpu: +p[3], ram: +p[4] }
    if (p[0] === 'H') s.host = { cpu: +p[1], used: +p[2], total: +p[3], disk: p[4] }
  }
  return s
})

ipcMain.handle('action', (_, id, act, c) => {
  const t = q(c.name)
  const cmds = {
    start: `tmux new -d -s ${t} -c ${q(c.dir || '~')} ${q(c.cmd || 'bash')}`,
    stop: `tmux send-keys -t ${t} ${q(c.stop || 'stop')} Enter`,
    kill: `tmux kill-session -t ${t}`,
    send: `tmux send-keys -t ${t} -l ${q(c.text)} && tmux send-keys -t ${t} Enter`
  }
  return run(id, cmds[act])
})

ipcMain.handle('open', async (_, id, spec, cols, rows) => {
  const c = await connect(id), sid = ++seq, pty = { term: 'xterm-256color', cols, rows }
  const cb = (e, s) => {
    if (e) return send('data', sid, `\r\n${e.message}\r\n`)
    streams.set(sid, s)
    s.on('data', d => send('data', sid, d.toString('utf8'))).stderr.on('data', d => send('data', sid, d.toString('utf8')))
    s.on('close', () => { streams.delete(sid); send('exit', sid) })
  }
  spec?.cmd ? c.exec(spec.cmd, { pty }, cb) : spec ? c.exec(`tmux set -q -t ${q(spec)} status off \\; attach -t ${q(spec)}`, { pty }, cb) : c.shell(pty, cb)
  return sid
})
ipcMain.on('write', (_, sid, d) => streams.get(sid)?.write(d))
ipcMain.on('resize', (_, sid, cols, rows) => streams.get(sid)?.setWindow(rows, cols, 0, 0))
ipcMain.on('close', (_, sid) => streams.get(sid)?.close())
ipcMain.handle('scroll', (_, id, name, n) => run(id, n < 0 ? `tmux copy-mode -e -t ${q(name)} \\; send-keys -X -N ${-n} -t ${q(name)} scroll-up` : `tmux send-keys -X -N ${n} -t ${q(name)} scroll-down`).catch(() => {}))
ipcMain.handle('cancel', (_, id, name) => run(id, `tmux send-keys -X -t ${q(name)} cancel`).catch(() => {}))
ipcMain.handle('copy', (_, t) => clipboard.writeText(t))
ipcMain.handle('paste', () => clipboard.readText())

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1300, height: 800, backgroundColor: '#14161a', autoHideMenuBar: true, title: 'RoyalConsole',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  // Zoom: the default menu only zooms in on Ctrl+Shift+=, so Ctrl+- was a one-way trip.
  // Handle zoom keys here so Ctrl+= / Ctrl++ / numpad + zoom in, Ctrl+- zooms out, Ctrl+0 resets.
  const wc = win.webContents
  const zoom = d => wc.setZoomLevel(d === 0 ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + d * 0.5)))
  wc.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown' || !(i.control || i.meta) || i.alt) return
    const k = i.key, c = i.code
    if (k === '=' || k === '+' || c === 'Equal' || c === 'NumpadAdd') zoom(1)
    else if (k === '-' || k === '_' || c === 'Minus' || c === 'NumpadSubtract') zoom(-1)
    else if (k === '0' || c === 'Digit0' || c === 'Numpad0') zoom(0)
    else return
    e.preventDefault()
  })
  wc.on('did-finish-load', () => wc.setZoomLevel(0))
  win.loadFile(path.join(__dirname, 'index.html'))
})
app.on('window-all-closed', () => app.quit())
