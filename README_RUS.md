# as-orca-plugins

🇬🇧 [English version](README.md)

Монорепо независимых плагинов для [Orca](https://github.com/stablyai/orca). Каждый плагин живёт в своей папке `plugins/<id>/` и публикуется через собственный каталог `orca-catalog.json`.

## Плагины

| Плагин | Папка | Что делает |
|--------|-------|------------|
| Live Markdown (`alexeyshishin.live-markdown`) | [plugins/live-markdown](plugins/live-markdown) | Live Preview для `.md` в стиле Obsidian: заголовки, жирный, курсив, код, таблицы с редактированием ячеек, блоки кода с подсветкой, чекбоксы, ссылки (интернет, якоря, файлы воркспейса), висячий отступ в списках. Маркеры разметки раскрываются только у узла под курсором. Включается вручную иконкой в переключателе вида. Подробности: [README плагина](plugins/live-markdown/README.md). |
| Git Gutter (`alexeyshishin.git-gutter`) | [plugins/git-gutter](plugins/git-gutter) | В разработке: цветная полоса слева от номера строки, показывающая добавленные, изменённые и удалённые строки по `git diff`. Пока только скелет папки. Подробности: [README плагина](plugins/git-gutter/README.md). |

Новый плагин = новая папка `plugins/<id>/` по правилам ниже + одна запись в `orca-catalog.json` + одна строка в этой таблице.

## Установка

Каталог плагинов — этот репозиторий: `https://github.com/alexeyshishin/as-orca-plugins`, ветка `main`. Orca должна иметь к нему доступ (публичный репозиторий).

1. Orca `>=1.4.248`, плагины включены (Settings → Plugins).
2. Settings → Plugins → Catalog sources → добавить Git URL каталога, ref `main`. Либо ссылка вида `https://onorca.dev/plugins/alexeyshishin.live-markdown?catalog=https://github.com/alexeyshishin/as-orca-plugins`.
3. Установить Live Markdown и одобрить доступ. Плагину нужен профиль `trusted-worker` (Orca показывает его как полный доступ) и права `workspace:read` / `workspace:write`: воркер открывает файлы по ссылкам в тексте. Метка плагина по адресу каталога, не Official и не Community.

Пока не выпущен первый релиз (см. «Ручной релиз»), `orca-catalog.json` без записей плагинов и установить из каталога нечего.

### Локальная загрузка для разработки

```sh
orca plugin dev load plugins/live-markdown
orca plugin dev reload plugins/live-markdown --approve <fingerprint>
```

Первая команда печатает, какой доступ запрашивает плагин, и fingerprint. Одобрение — решение владельца Orca; любые изменения доступа (профиль, права, команды) требуют нового fingerprint, а правки кода в dev-папке запускаются без повторного запроса. Пока плагин не одобрен, он загружен, но не работает.

## Правила монорепо

- **R1.** Одна папка = один плагин = один `orca-plugin.json` = свой `package.json` и lockfile = свои README, LICENSE, тесты.
- **R2.** Граница плагина не пересекается: никаких `import` / `require` / `<script src>` / `fetch` на `../` за пределы папки, симлинков, общих `packages/`, корневого `package.json`, workspaces, hoisting и общего build-конфига. Каталог ставит только `plugins/<id>/`, `contentHash` считается по ней одной, frame видит только свои файлы, `..` в путях манифеста отклоняется, лимит 2000 файлов / 50 MiB на плагин.
- **R3.** Нет runtime-связи между плагинами: у каждого свои partition, storage и origin.
- **R4.** Мелкие хелперы дублируются копированием, дубли приняты.
- **R5.** Общим может быть только проза (README), `.gitignore`, `orca-catalog.json` (метаданные) и `scripts/validate-all.sh` (не больше 5 строк). Код — никогда.
- **R6.** Версии независимы; теги `<plugin>/vX.Y.Z`; общего `vX.Y.Z` нет.
- **R7.** Scope коммита = имя папки плагина: `feat(live-markdown): ...`.

Папки `plugins/<id>` не переименовываются и не переносятся: путь входит в источник, который одобряют пользователи. CI нет: ни workflow-файлов, ни пайплайнов.

## Проверки

Ручные, по каждому плагину отдельно. Нужен Orca `>=1.4.248` (`orca plugin --help` — источник истины по подкомандам).

```sh
orca plugin validate plugins/<id>
orca plugin check plugins/<id>
cd plugins/<id>/build && npm ci --ignore-scripts && npm test
scripts/validate-all.sh
```

Независимость: копия папки плагина в пустую temp-папку проходит `orca plugin validate`; `find . -type l` пуст; в плагине нет путей на `../` за его пределы.

## Ручной релиз (каждый плагин отдельно)

1. Поднять `version` в `plugins/<id>/orca-plugin.json`.
2. Пересобрать плагин (для `live-markdown`: `cd plugins/live-markdown/build && npm ci --ignore-scripts && node build.mjs`) и прогнать тесты.
3. Закоммитить плагин. Бандл должен быть в HEAD: незакоммиченное в запись каталога не попадает.
4. В папке плагина выполнить `orca plugin release-entry`: версия, 40-символьный SHA, `contentHash`, `execution`, `minimumOrca`, `source.path`.
5. Вставить запись в `orca-catalog.json`: плагин `alexeyshishin.<id>`, `releases[]` — новые сверху, старые релизы сохранять при повышении `engines.orca`.
6. `orca plugin validate .` в корне.
7. Коммит `chore(catalog): add <id> <version>`.
8. Тег `<id>/v<version>` на закреплённый коммит плагина; версия тега равна `version` в манифесте. Тег ставится после локальных `orca plugin validate` и тестов.