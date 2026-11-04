# as-orca-plugins

🇷🇺 [Русская версия](README_RUS.md)

A monorepo of independent plugins for [Orca](https://github.com/stablyai/orca). Each plugin lives in its own `plugins/<id>/` folder and is published through its own catalog, `orca-catalog.json`.

## Plugins

| Plugin | Folder | What it does |
|--------|--------|--------------|
| Live Markdown (`alexeyshishin.live-markdown`) | [plugins/live-markdown](plugins/live-markdown) | Obsidian-style Live Preview for `.md` files: headings, bold, italic, code, tables with cell editing, code blocks with syntax highlighting, checkboxes, links (internet, anchors, workspace files), hanging indent in lists. Markup markers are revealed only on the node under the cursor. Enabled manually with an icon in the view switcher. Details: [plugin README](plugins/live-markdown/README.md). |
| Git Gutter (`alexeyshishin.git-gutter`) | [plugins/git-gutter](plugins/git-gutter) | In development: a colored bar to the left of the line number showing added, modified and deleted lines based on `git diff`. So far only the folder skeleton exists. Details: [plugin README](plugins/git-gutter/README.md). |

A new plugin = a new `plugins/<id>/` folder following the rules below + one entry in `orca-catalog.json` + one row in this table.

## Installation

The plugin catalog is this repository: `https://github.com/alexeyshishin/as-orca-plugins`, branch `main`. Orca must have access to it (public repository).

1. Orca `>=1.4.248` with plugins enabled (Settings → Plugins).
2. Settings → Plugins → Catalog sources → add the catalog Git URL, ref `main`. Or use a link like `https://onorca.dev/plugins/alexeyshishin.live-markdown?catalog=https://github.com/alexeyshishin/as-orca-plugins`.
3. Install Live Markdown and approve the access. The plugin needs the `trusted-worker` profile (Orca shows it as full access) and the `workspace:read` / `workspace:write` permissions: the worker opens files from links in the text. The plugin is labeled by its catalog address, neither Official nor Community.

Until the first release is published (see "Manual release"), `orca-catalog.json` has no plugin entries and there is nothing to install from the catalog.

### Local loading for development

```sh
orca plugin dev load plugins/live-markdown
orca plugin dev reload plugins/live-markdown --approve <fingerprint>
```

The first command prints the access the plugin requests and a fingerprint. Approval is the Orca owner's decision; any change to access (profile, permissions, commands) requires a new fingerprint, while code edits in the dev folder run without a new prompt. Until the plugin is approved, it is loaded but does not work.

## Monorepo rules

- **R1.** One folder = one plugin = one `orca-plugin.json` = its own `package.json` and lockfile = its own README, LICENSE and tests.
- **R2.** The plugin boundary is never crossed: no `import` / `require` / `<script src>` / `fetch` to `../` outside the folder, no symlinks, shared `packages/`, root `package.json`, workspaces, hoisting or shared build config. The catalog installs only `plugins/<id>/`, `contentHash` is computed over it alone, the frame sees only its own files, `..` in manifest paths is rejected, and the limit is 2000 files / 50 MiB per plugin.
- **R3.** No runtime link between plugins: each has its own partition, storage and origin.
- **R4.** Small helpers are duplicated by copying; duplicates are accepted.
- **R5.** Only prose (README), `.gitignore`, `orca-catalog.json` (metadata) and `scripts/validate-all.sh` (at most 5 lines) can be shared. Code — never.
- **R6.** Versions are independent; tags are `<plugin>/vX.Y.Z`; there is no shared `vX.Y.Z`.
- **R7.** Commit scope = plugin folder name: `feat(live-markdown): ...`.

`plugins/<id>` folders are not renamed or moved: the path is part of the source that users approve. There is no CI: no workflow files, no pipelines.

## Checks

Manual, for each plugin separately. Requires Orca `>=1.4.248` (`orca plugin --help` is the source of truth for subcommands).

```sh
orca plugin validate plugins/<id>
orca plugin check plugins/<id>
cd plugins/<id>/build && npm ci --ignore-scripts && npm test
scripts/validate-all.sh
```

Independence: a copy of the plugin folder in an empty temp folder passes `orca plugin validate`; `find . -type l` is empty; the plugin has no paths to `../` outside of it.

## Manual release (each plugin separately)

1. Bump `version` in `plugins/<id>/orca-plugin.json`.
2. Rebuild the plugin (for `live-markdown`: `cd plugins/live-markdown/build && npm ci --ignore-scripts && node build.mjs`) and run the tests.
3. Commit the plugin. The bundle must be in HEAD: anything uncommitted does not make it into the catalog entry.
4. In the plugin folder run `orca plugin release-entry`: version, 40-character SHA, `contentHash`, `execution`, `minimumOrca`, `source.path`.
5. Insert the entry into `orca-catalog.json`: plugin `alexeyshishin.<id>`, `releases[]` — newest first; keep old releases when raising `engines.orca`.
6. Run `orca plugin validate .` in the root.
7. Commit `chore(catalog): add <id> <version>`.
8. Tag `<id>/v<version>` on the pinned plugin commit; the tag version equals `version` in the manifest. The tag is set after the local `orca plugin validate` and tests.
