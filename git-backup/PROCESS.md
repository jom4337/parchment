# Git backup process

This file tells how changes from Claude chats go into this repository. The Claude project keeps the same text as `git-backup-status.md`.

## Repository

| Item | Value |
|---|---|
| Repository | `parchment` |
| Archive top folder | `parchment/` |
| Local clone | `~/Projects/Parchment/parchment` |
| Remote `origin` | Private copy on the owner's own Git server |
| Remote `github` | Public: https://github.com/jom4337/parchment |
| Default branch | `main` |

The repository is public. Everything in it is visible to everyone.

The folder `~/Projects/Parchment/` around the clone is a workspace. Its files stay outside the repository: `tools/`, `ruleset-dco.json`, `release-X.Y.Z/`, `release-notes-vX.Y.Z.md`, and the guide.

## Process

1. Claude delivers an archive named `parchment-<area>-<topic>.tar.gz`. Every path in it starts with `parchment/`.
2. Claude gives the repository path of each file in the archive.
3. The owner runs the dry run, compares it with the counts that Claude gives, and then runs `--go`.
4. `--go` commits, pushes to `origin`, and then pushes to `github`.

```zsh
cd ~/Projects/Parchment/parchment && git status -sb         # must be clean
REPO_DIR=~/Projects/Parchment/parchment ~/bin/repo-sync.sh ~/Downloads/<archive>          # dry run
REPO_DIR=~/Projects/Parchment/parchment ~/bin/repo-sync.sh ~/Downloads/<archive> --go
```

Archive rules:

- One top folder: `parchment/`. Paths are relative to the repository root. No `/` at the start and no `..`.
- A partial archive is correct. Files that are not in the archive stay as they are.
- To move or rename a file, add the new path and list the old path in `parchment/.repo-sync/delete.txt`.
- No symbolic links.

Commits on `main` must have a `Signed-off-by` line (DCO, see `CONTRIBUTING.md`). Pull requests into `main` need the `dco` check to pass. The owner can push directly.

For a change that the owner makes by hand:

```zsh
cd ~/Projects/Parchment/parchment
git add <path>
git commit -s -m "<area>: <what>"
git push origin main && git push github main
```

## Area layout

| Path | Contents |
|---|---|
| `src/` | Page code for all versions: Markdown render, themes, Find, bridges |
| `src-tauri/` | Tauri desktop app: Rust main process, config, icons, license notice templates |
| `android/` | Android app: WebView wrapper in Java, Gradle build |
| `scripts/` | Build script (`build.js`) |
| `samples/` | Sample Markdown files for tests |
| `build/` | App icon source |
| `.github/workflows/` | CI: DCO check, Linux and Windows build, Android build |
| `git-backup/` | This process |
| Root files | `README.md`, `CONTRIBUTING.md`, `LICENSE`, `THIRD_PARTY_NPM.md`, `THIRD_PARTY_RUST.html`, `package.json`, `package-lock.json`, `.gitignore` |

A new area gets a new top folder with a `README.md`. Add it to this table in the same archive.

## Never commit

- Signing keys and their passwords: the Android release keystore (`*.jks`, `*.keystore`), `*.key`, `*.pem`, `*.p12`, `.env`. The keystore stays outside the repository. Its password is only in the GitHub secret and the owner's password manager.
- Secret values of any kind: tokens, passwords, GitHub secret values.
- Host names, IP addresses, server addresses, or other private network details. This includes the address of the `origin` server.
- Build output: `node_modules/`, `dist/`, `renderer-tauri/`, `release/`, `src-tauri/target/`, `src-tauri/gen/`, `android/.gradle/`, `android/build/`, `android/app/build/`, `android/local.properties`.
- Release files (`.dmg`, `.deb`, `.rpm`, `.exe`, `.apk`). They go to GitHub Releases.
- Any file over 50 MB, disk images, and backups.
- `.DS_Store`.

Before each commit, look for secrets in new logs and notes.
