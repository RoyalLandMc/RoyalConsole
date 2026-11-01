# RoyalConsole

SSH console and server monitor for Windows. Every server runs in a tmux session on its host; RoyalConsole lists them, attaches to their consoles in tabs, and shows CPU, RAM and uptime.

```
npm install
npm start
npm run dist   # dist/RoyalConsole-Setup-*.exe
```

Hosts are saved in `%APPDATA%/royalconsole/hosts.json`. Key login only (default `~/.ssh/id_ed25519`).
