const { contextBridge, ipcRenderer: r, webUtils } = require('electron')

contextBridge.exposeInMainWorld('api', {
  hosts: () => r.invoke('hosts'),
  saveHost: h => r.invoke('host-save', h),
  delHost: id => r.invoke('host-del', id),
  connect: id => r.invoke('connect', id),
  disconnect: id => r.invoke('disconnect', id),
  run: (id, cmd) => r.invoke('run', id, cmd),
  stats: id => r.invoke('stats', id),
  action: (id, act, c) => r.invoke('action', id, act, c),
  open: (id, name, cols, rows) => r.invoke('open', id, name, cols, rows),
  write: (sid, d) => r.send('write', sid, d),
  resize: (sid, c, rw) => r.send('resize', sid, c, rw),
  close: sid => r.send('close', sid),
  scroll: (id, name, n) => r.invoke('scroll', id, name, n),
  cancel: (id, name) => r.invoke('cancel', id, name),
  copy: t => r.invoke('copy', t),
  paste: () => r.invoke('paste'),
  fs: (id, op, ...a) => r.invoke('fs', id, op, ...a),
  pathOf: f => webUtils.getPathForFile(f),
  on: (ch, f) => r.on(ch, (_, ...a) => f(...a))
})
