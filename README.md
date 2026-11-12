# RoyalConsole

SSH console and server monitor for Windows. Every server runs in a tmux session on its host; RoyalConsole lists them, attaches to their consoles in tabs, and shows CPU, RAM and uptime.

![RoyalConsole with sample servers](docs/preview.png)

*The screenshot uses sample data.*

```
npm install
npm start
npm run dist   # dist/RoyalConsole-Setup-*.exe
```

Hosts are saved in `%APPDATA%/royalconsole/hosts.json`. Key login only (default `~/.ssh/id_ed25519`).

Releases: bump `version` in `package.json`, commit, then push a matching tag (`git tag v0.2.4 && git push origin v0.2.4`). GitHub Actions builds the installer and publishes the release.
