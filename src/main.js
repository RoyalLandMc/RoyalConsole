const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto')
const { Client } = require('ssh2')

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

function connect(id) {
  if (conns.has(id)) return conns.get(id)
  const h = loadHosts().find(x => x.id === id)
  const p = new Promise((res, rej) => {
    const c = new Client()
    c.on('ready', () => res(c))
      .on('error', e => { conns.delete(id); rej(e) })
      .on('close', () => { conns.delete(id); send('host-closed', id) })
    c.connect({
      host: h.host, port: +h.port || 22, username: h.user,
      privateKey: fs.readFileSync(h.key || path.join(os.homedir(), '.ssh', 'id_ed25519')),
      keepaliveInterval: 15000, readyTimeout: 15000,
      hostVerifier: k => {
        const fp = crypto.createHash('sha256').update(k).digest('base64')
        if (!h.fp) { h.fp = fp; updateHost(h); return true }
        return h.fp === fp
      }
    })
  })
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

ipcMain.handle('hosts', () => loadHosts())
ipcMain.handle('host-save', (_, h) => { h.id ||= crypto.randomUUID(); updateHost(h); return h })
ipcMain.handle('host-del', (_, id) => { saveHosts(loadHosts().filter(x => x.id !== id)); conns.get(id)?.then(c => c.end()).catch(() => {}) })
ipcMain.handle('connect', async (_, id) => { await connect(id); return true })
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

ipcMain.handle('open', async (_, id, name, cols, rows) => {
  const c = await connect(id), sid = ++seq, pty = { term: 'xterm-256color', cols, rows }
  const cb = (e, s) => {
    if (e) return send('data', sid, `\r\n${e.message}\r\n`)
    streams.set(sid, s)
    s.on('data', d => send('data', sid, d.toString('utf8'))).stderr.on('data', d => send('data', sid, d.toString('utf8')))
    s.on('close', () => { streams.delete(sid); send('exit', sid) })
  }
  name ? c.exec(`tmux attach -t ${q(name)}`, { pty }, cb) : c.shell(pty, cb)
  return sid
})
ipcMain.on('write', (_, sid, d) => streams.get(sid)?.write(d))
ipcMain.on('resize', (_, sid, cols, rows) => streams.get(sid)?.setWindow(rows, cols, 0, 0))
ipcMain.on('close', (_, sid) => streams.get(sid)?.close())

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1300, height: 800, backgroundColor: '#14161a', autoHideMenuBar: true, title: 'RoyalConsole',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  win.loadFile(path.join(__dirname, 'index.html'))
})
app.on('window-all-closed', () => app.quit())
