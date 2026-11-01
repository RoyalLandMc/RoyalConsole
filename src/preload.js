const { contextBridge, ipcRenderer: r } = require('electron')

contextBridge.exposeInMainWorld('api', {
  hosts: () => r.invoke('hosts'),
  saveHost: h => r.invoke('host-save', h),
  delHost: id => r.invoke('host-del', id),
  connect: id => r.invoke('connect', id),
  run: (id, cmd) => r.invoke('run', id, cmd),
  stats: id => r.invoke('stats', id),
  action: (id, act, c) => r.invoke('action', id, act, c),
  open: (id, name, cols, rows) => r.invoke('open', id, name, cols, rows),
  write: (sid, d) => r.send('write', sid, d),
  resize: (sid, c, rw) => r.send('resize', sid, c, rw),
  close: sid => r.send('close', sid),
  on: (ch, f) => r.on(ch, (_, ...a) => f(...a))
})
