























exports.repo = "hugo529100/hfs-Plugins-Repair"
exports.version = 2.42
exports.apiRequired = 12.7
exports.description = 'Analyze and repair the installed plugin library: three-way check between online catalog, plugin folders and config.yaml, seamless config migration, safe folder renames, plugin.js repo fixes and trash-based deletion.'
exports.preview = []
exports.changelog = []

exports.config = {
    deepOnlineByDefault: {
        type: 'boolean', defaultValue: false, label: 'Deep online check by default',
        helperText: 'Verify every repository against GitHub (repo exists + latest plugin.js version) instead of relying on the Plugins-Optimizer catalog mirror only. Slower and needs network access.',
        xs: 12,
    },
    backupTime: {
        type: 'string', defaultValue: '', label: 'Daily config backup time (HH:MM)',
        helperText: 'Local server time. Leave empty to disable automatic backups. Example: 03:30.',
        xs: 6,
    },
    backupLimit: {
        type: 'number', defaultValue: 30, min: 5, max: 500, label: 'Keep this many config backups',
        helperText: 'Backups are written next to config.yaml in config-backup/ as config.yaml.repair-bak-YYYYMMDD-HHMMSS. Oldest are pruned.',
        xs: 6,
    },
    ignoreFolders: {
        type: 'string', defaultValue: 'Backup,PATCH', label: 'Ignored folder names',
        helperText: 'Comma-separated folder names under plugins/ that are not plugin folders (backups, patches, tools). They are skipped by the scan and never renamed or deleted.',
        xs: 12,
    },
    ignorePlugins: {
        type: 'string', defaultValue: '', label: 'Ignored plugin names',
        helperText: 'Comma-separated plugin ids to exclude from scan, orphan checks and repairs (e.g. Unsorted-test, hfs-foo-main).',
        xs: 12,
    },
    debug: {
        type: 'boolean', defaultValue: false, label: 'Debug logging',
        helperText: 'Print detailed scan/apply traces to the HFS console.',
        xs: 12,
    },
}

exports.init = async api => {
    const fs = api.require('fs')
    const path = api.require('path')
    const crypto = api.require('crypto')
    const https = api.require('https')

    
    
    const hfsPlugins = (() => {
        try {
            const m = api.require('./plugins')
            return m && typeof m === 'object' ? m : null
        } catch { return null }
    })()
    const hfsPluginsAvailable = !!(hfsPlugins && (hfsPlugins.rescan || hfsPlugins.enablePlugin))

    const PLUGIN_ID = 'Plugins-Repair'
    const storageDir = api.storageDir
    const SELF_DIR = path.dirname(storageDir)
    const PLUGINS_ROOT = process.env.PLUGINS_REPAIR_ROOT
        ? path.resolve(process.env.PLUGINS_REPAIR_ROOT)
        : path.dirname(SELF_DIR)
    const HFS_ROOT = path.dirname(PLUGINS_ROOT)
    const CONFIG_NAME = 'config.yaml'
    const BACKUP_DIR = path.join(HFS_ROOT, 'config-backup')
    const MIRROR_FILE = path.join(PLUGINS_ROOT, 'Plugins-Optimizer', 'storage', 'catalog.json')
    const OPTIMIZER_CACHE_DIR = path.join(PLUGINS_ROOT, 'Plugins-Optimizer', 'storage', 'cache')
    const ONLINE_CACHE = path.join(storageDir, 'online-cache.json')
    const OWNER_CACHE = path.join(storageDir, 'owner-repos.json')
    const REPO_CACHE = path.join(storageDir, 'online-repos.json')
    const DECISIONS_FILE = path.join(storageDir, 'decisions.json')
    const JOURNAL_FILE = path.join(storageDir, 'journal.jsonl')
    const LAST_BATCH_FILE = path.join(storageDir, 'last-batch.json')
    const TRASH_DIR = path.join(storageDir, 'trash')
    const BACKUP_IN_SELF = path.join(storageDir, 'backups')
    const CANONICAL_OWNER = 'hugo529100'
    const OWNER_ALIASES = new Set(['hug3o', 'hugo29100', 'hugo529100'])
    
    const NATIVE_PLUGINS = new Set(['antibrute', 'download-counter', 'list-uploader'])
    const ADMIN_TOKEN = crypto.randomBytes(24).toString('hex')

    const debugEnabled = () => {
        const v = api.getConfig('debug')
        return v === true || v === 'true' || v === 1 || v === '1'
    }
    const logDebug = (...a) => { if (debugEnabled()) api.log('[repair]', ...a) }

    
    
    
    const exists = p => { try { return fs.existsSync(p) } catch { return false } }
    const isDir = p => { try { return fs.statSync(p).isDirectory() } catch { return false } }
    const readText = p => fs.readFileSync(p, 'utf8')
    const ensureDir = p => { try { fs.mkdirSync(p, { recursive: true }) } catch (e) { logDebug('mkdir failed', p, e.message) } }
    const listDirs = root => {
        try {
            return fs.readdirSync(root, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name)
                .sort((a, b) => a.localeCompare(b))
        } catch { return [] }
    }
    function timestamp(date) {
        const d = date || new Date()
        const p = n => String(n).padStart(2, '0')
        return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    }
    function fmtStamp(ms) {
        if (!ms) return ''
        const d = new Date(ms)
        const p = n => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }
    function readJsonFile(file, fallback) {
        try { return JSON.parse(String(fs.readFileSync(file, 'utf8')).replace(/^\uFEFF/, '')) } catch { return fallback }
    }
    function writeJsonFile(file, data) {
        ensureDir(path.dirname(file))
        const tmp = file + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
        try { fs.renameSync(tmp, file) } catch { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); try { fs.unlinkSync(tmp) } catch {} }
    }
    function appendJournal(entry) {
        try {
            ensureDir(storageDir)
            fs.appendFileSync(JOURNAL_FILE, JSON.stringify(entry) + '\n', 'utf8')
        } catch (e) { logDebug('journal failed', e.message) }
    }

    
    
    
    function splitRecords(text) {
        const out = []
        let pos = 0
        while (pos <= text.length) {
            const nl = text.indexOf('\n', pos)
            if (nl < 0) break
            const hasCr = nl > pos && text[nl - 1] === '\r'
            out.push({ text: text.slice(pos, hasCr ? nl - 1 : nl), eol: hasCr ? '\r\n' : '\n' })
            pos = nl + 1
        }
        if (pos < text.length) out.push({ text: text.slice(pos), eol: '' })
        else if (!out.length) out.push({ text: '', eol: '' })
        return out
    }
    const indentOf = line => line.length - line.trimStart().length
    const isBlankOrComment = line => {
        const t = line.trim()
        return !t || t.startsWith('#')
    }
    function unquote(s) {
        const t = String(s).trim()
        const m = t.match(/^"([\s\S]*)"$/) || t.match(/^'([\s\S]*)'$/)
        return m ? m[1] : t
    }
    function quoteKey(key) {
        return /^[A-Za-z0-9_.\-+()]+$/.test(key) ? key : JSON.stringify(key)
    }
    function dominantEol(records) {
        const crlf = records.filter(r => r.eol === '\r\n').length
        const lf = records.filter(r => r.eol === '\n').length
        return crlf > lf ? '\r\n' : '\n'
    }

    function parseDoc(text) {
        const records = splitRecords(text)
        const lines = records.map(r => r.text)
        const doc = { records, lines, plugins: null, enable: null, eol: dominantEol(records) }

        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            if (!line || line[0] === ' ' || line[0] === '\t') continue
            const m = line.match(/^([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/)
            if (!m) continue
            if (m[1] === 'enable_plugins') doc.enable = { keyLine: i, value: m[2] }
            if (m[1] === 'plugins_config') doc.plugins = { keyLine: i, value: m[2] }
        }
        const blockEnd = keyLine => {
            for (let i = keyLine + 1; i < lines.length; i++) {
                if (!lines[i] || lines[i][0] === ' ' || lines[i][0] === '\t') continue
                if (lines[i].trim().startsWith('#')) continue
                return i
            }
            return lines.length
        }

        
        if (doc.enable) {
            const end = blockEnd(doc.enable.keyLine)
            const items = []
            for (let i = doc.enable.keyLine + 1; i < end; i++) {
                const m = lines[i].match(/^(\s*)-\s*(.*)$/)
                if (!m) continue
                items.push({ line: i, value: unquote(m[2]), raw: lines[i] })
            }
            doc.enable = { ...doc.enable, start: doc.enable.keyLine + 1, end, items }
        }

        
        if (doc.plugins) {
            const end = blockEnd(doc.plugins.keyLine)
            const sections = []
            for (let i = doc.plugins.keyLine + 1; i < end; i++) {
                const line = lines[i]
                if (isBlankOrComment(line)) continue
                const indent = indentOf(line)
                if (indent !== 2) continue
                const m = line.match(/^(\s*)("[^"]+"|'[^']+'|[^:#][^:]*):\s*(.*)$/)
                if (!m) continue
                sections.push({
                    key: unquote(m[2]),
                    keyLine: i,
                    startLine: i,
                    endLine: end,
                    value: m[3],
                    entries: [],
                })
            }
            for (let s = 0; s < sections.length; s++) {
                sections[s].endLine = s + 1 < sections.length ? sections[s + 1].keyLine : end
                const entries = []
                for (let i = sections[s].keyLine + 1; i < sections[s].endLine; i++) {
                    const line = lines[i]
                    if (isBlankOrComment(line)) continue
                    if (indentOf(line) !== 4) continue
                    if (line.trim().startsWith('- ')) continue
                    const m = line.match(/^(\s*)("[^"]+"|'[^']+'|[^:#][^:]*):(.*)$/)
                    if (!m) continue
                    entries.push({ key: unquote(m[2]), line: i, endLine: sections[s].endLine })
                }
                for (let e = 0; e < entries.length; e++)
                    entries[e].endLine = e + 1 < entries.length ? entries[e + 1].line : sections[s].endLine
                sections[s].entries = entries
            }
            doc.plugins = { ...doc.plugins, start: doc.plugins.keyLine + 1, end, sections }
        }
        return doc
    }

    function findTopKeyLine(doc, key) {
        for (let i = 0; i < doc.lines.length; i++) {
            if (doc.lines[i].startsWith(key + ':')) return i
        }
        return -1
    }

    function setSectionKey(doc, section, newKey) {
        const line = doc.lines[section.keyLine]
        const m = line.match(/^(\s*)("[^"]+"|'[^']+'|[^:#][^:]*)(\s*:.*)$/)
        if (!m) return false
        const quoted = m[2].startsWith('"') || m[2].startsWith("'")
        doc.lines[section.keyLine] = m[1] + (quoted ? m[2][0] + newKey + m[2][0] : quoteKey(newKey)) + m[3]
        return true
    }

    
    function trimSectionTail(lines, start, end) {
        let e = end
        while (e > start + 1) {
            const line = lines[e - 1]
            if (!line.trim() || (line.trim().startsWith('#') && indentOf(line) <= 2)) e--
            else break
        }
        return e
    }

    function planConfigOps(doc, ops) {
        
        
        const lines = doc.lines.slice()
        const inserted = new Map() 
        const removed = new Set()
        const touched = new Set()
        const notes = []

        const sectionsNow = () => parseDoc(lines.join('\n')).plugins
        for (const op of ops) {
            const plugins = sectionsNow()
            if (!plugins) continue
            if (op.type === 'renameSection') {
                if (op.from === op.to) continue
                const sec = plugins.sections.find(s => s.key === op.from)
                if (!sec) { notes.push(`config section ${op.from} not found`); continue }
                const copy = { keyLine: sec.keyLine }
                if (setSectionKey({ lines }, copy, op.to)) touched.add(sec.keyLine)
            } else if (op.type === 'mergeSections') {
                const src = plugins.sections.find(s => s.key === op.from)
                const dst = plugins.sections.find(s => s.key === op.to)
                if (!src || !dst || op.from === op.to) { if (src && !dst) notes.push(`target section ${op.to} missing`); continue }
                const dstKeys = new Set(dst.entries.map(e => e.key))
                const blocks = []
                for (const e of src.entries) {
                    if (dstKeys.has(e.key)) continue
                    const end = Math.min(e.endLine, src.endLine)
                    blocks.push({ lines: lines.slice(e.line, end) })
                    dstKeys.add(e.key)
                }
                
                if (dst.entries.length === 0 && /^null\s*(#.*)?$/.test(String(dst.value).trim())) {
                    lines[dst.keyLine] = lines[dst.keyLine].replace(/\s*:.*$/, ':')
                }
                if (blocks.length) {
                    const list = inserted.get(dst.endLine) || []
                    for (const b of blocks) list.push(...b.lines)
                    inserted.set(dst.endLine, list)
                    notes.push(`merged ${blocks.length} key(s) from ${op.from}`)
                }
                removeRange(lines, src.startLine, trimSectionTail(lines, src.startLine, src.endLine))
                
                return planConfigOps(parseDoc(rebuild(lines, inserted, removed, doc.eol)), ops.slice(ops.indexOf(op) + 1))
            } else if (op.type === 'removeSections') {
                for (const key of op.keys || []) {
                    const sec = plugins.sections.find(s => s.key === key)
                    if (!sec) continue
                    removeRange(lines, sec.startLine, trimSectionTail(lines, sec.startLine, sec.endLine))
                }
            } else if (op.type === 'removeConfigKeys') {
                const sec = plugins.sections.find(s => s.key === op.section)
                if (!sec) continue
                for (const key of op.keys || []) {
                    const entry = sec.entries.find(e => e.key === key)
                    if (!entry) continue
                    removeRange(lines, entry.line, trimSectionTail(lines, entry.line, entry.endLine))
                }
            } else if (op.type === 'renameEnable') {
                const en = parseDoc(lines.join('\n')).enable
                if (!en) continue
                let seenTarget = false
                let hit = false
                for (const item of en.items) {
                    const isFrom = item.value === op.from
                    const isTo = item.value === op.to
                    if (!isFrom && !isTo) continue
                    if (seenTarget) { removed.add(item.line); continue }
                    if (isTo) { seenTarget = true; continue }
                    lines[item.line] = lines[item.line].replace(/^(\s*-\s*).*$/, `$1${quoteKey(op.to)}`)
                    seenTarget = true
                    hit = true
                    touched.add(item.line)
                }
                if (!hit && !seenTarget) notes.push(`enable entry ${op.from} not found`)
            } else if (op.type === 'removeEnable') {
                const en = parseDoc(lines.join('\n')).enable
                if (!en) continue
                const seen = new Set()
                for (const item of en.items) {
                    if (op.values.includes(item.value) || seen.has(item.value)) {
                        removed.add(item.line)
                    }
                    seen.add(item.value)
                }
            }
            void touched
        }
        return { text: rebuild(lines, inserted, removed, doc.eol), notes }

        function removeRange(arr, start, end) {
            for (let i = start; i < end; i++) removed.add(i)
        }
    }

    function rebuild(lines, inserted, removed, eol) {
        const out = []
        for (let i = 0; i < lines.length; i++) {
            const ins = inserted.get(i)
            if (ins) out.push(...ins)
            if (removed.has(i)) continue
            out.push(lines[i])
        }
        const ins = inserted.get(lines.length)
        if (ins) out.push(...ins)
        return out.join(eol)
    }

    function validateConfig(text, expected) {
        const doc = parseDoc(text)
        if (!doc.plugins) return 'plugins_config block disappeared'
        const keys = doc.plugins.sections.map(s => s.key)
        const seen = new Set()
        for (const k of keys) {
            if (seen.has(k)) return `duplicate config section: ${k}`
            seen.add(k)
        }
        for (const k of expected.mustHave || []) {
            if (!seen.has(k)) return `expected section missing: ${k}`
        }
        for (const k of expected.mustNotHave || []) {
            if (seen.has(k)) return `section should be gone: ${k}`
        }
        const en = doc.enable
        if (expected.enableMustHave?.length) {
            const vals = new Set(en ? en.items.map(i => i.value) : [])
            for (const v of expected.enableMustHave) if (!vals.has(v)) return `enable entry missing: ${v}`
        }
        if (expected.enableMustNotHave?.length) {
            const vals = new Set(en ? en.items.map(i => i.value) : [])
            for (const v of expected.enableMustNotHave) if (vals.has(v)) return `enable entry should be gone: ${v}`
        }
        for (const { section, key } of expected.mustNotHaveKeys || []) {
            const sec = doc.plugins.sections.find(s => s.key === section)
            if (sec && sec.entries.some(e => e.key === key))
                return `setting should be gone: ${section}.${key}`
        }
        return null
    }

    
    
    
    function uniquePath(dir, base, ext) {
        ensureDir(dir)
        for (let n = 0; n < 200; n++) {
            const p = path.join(dir, base + (n ? '-' + n : '') + ext)
            if (!exists(p)) return p
        }
        return path.join(dir, base + '-' + Date.now() + ext)
    }
    function pruneBackups() {
        const limit = Math.max(5, Number(api.getConfig('backupLimit')) || 30)
        try {
            const files = fs.readdirSync(BACKUP_DIR)
                .filter(n => n.startsWith(CONFIG_NAME + '.repair-bak-'))
                .sort()
            for (const name of files.slice(0, Math.max(0, files.length - limit)))
                try { fs.unlinkSync(path.join(BACKUP_DIR, name)) } catch {}
        } catch {}
    }
    function writeConfigText(text) {
        ensureDir(BACKUP_DIR)
        const bak = uniquePath(BACKUP_DIR, CONFIG_NAME + '.repair-bak-' + timestamp(), '')
        fs.copyFileSync(CONFIG_PATH, bak)
        const tmp = CONFIG_PATH + '.repair-tmp'
        fs.writeFileSync(tmp, text, 'utf8')
        try { fs.renameSync(tmp, CONFIG_PATH) } catch {
            try { fs.unlinkSync(tmp) } catch {}
            fs.writeFileSync(CONFIG_PATH, text, 'utf8')
        }
        if (fs.readFileSync(CONFIG_PATH, 'utf8') !== text) throw Error('config.yaml verification failed')
        pruneBackups()
        return bak
    }

    function configBackupFiles() {
        try {
            return fs.readdirSync(BACKUP_DIR)
                .filter(n => n.startsWith(CONFIG_NAME + '.repair-bak-'))
                .map(name => {
                    const file = path.join(BACKUP_DIR, name)
                    try {
                        const st = fs.statSync(file)
                        return { name, file, size: st.size, mtime: st.mtimeMs }
                    } catch { return null }
                })
                .filter(Boolean)
                .sort((a, b) => a.name.localeCompare(b.name))
        } catch { return [] }
    }

    function pluginJsBackupStats() {
        let count = 0
        let size = 0
        try {
            for (const day of fs.readdirSync(BACKUP_IN_SELF)) {
                const dir = path.join(BACKUP_IN_SELF, day)
                if (!isDir(dir)) continue
                for (const name of fs.readdirSync(dir)) {
                    if (!name.endsWith('.plugin.js')) continue
                    try { size += fs.statSync(path.join(dir, name)).size; count++ } catch {}
                }
            }
        } catch {}
        return { count, size }
    }

    function backupStats() {
        const files = configBackupFiles()
        const latest = files[files.length - 1] || null
        return {
            config: {
                count: files.length,
                size: files.reduce((n, f) => n + f.size, 0),
                latest: latest ? { name: latest.name, mtime: latest.mtime } : null,
                files: files.map(f => ({ name: f.name, size: f.size, mtime: f.mtime })),
            },
            pluginJs: pluginJsBackupStats(),
            limit: Math.max(5, Number(api.getConfig('backupLimit')) || 30),
        }
    }

    function cleanupConfigBackups(mode = 'old') {
        const files = configBackupFiles()
        const limit = Math.max(5, Number(api.getConfig('backupLimit')) || 30)
        const remove = mode === 'all' ? files : files.slice(0, Math.max(0, files.length - limit))
        const deletedNames = []
        for (const f of remove) {
            try { fs.unlinkSync(f.file); deletedNames.push(f.name) } catch {}
        }
        return { deleted: deletedNames.length, deletedNames, remaining: files.length - deletedNames.length }
    }

    function createConfigBackup() {
        if (!exists(CONFIG_PATH)) throw Error('config.yaml not found')
        ensureDir(BACKUP_DIR)
        const bak = uniquePath(BACKUP_DIR, CONFIG_NAME + '.repair-bak-' + timestamp(), '')
        fs.copyFileSync(CONFIG_PATH, bak)
        pruneBackups()
        return bak
    }

    let autoBackupDay = ''
    function maybeAutoBackup() {
        let time = ''
        try { time = String(api.getConfig('backupTime') || '').trim() } catch {}
        if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) return
        const now = new Date()
        const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
        if (hhmm !== time) return
        const day = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
        if (autoBackupDay === day) return
        autoBackupDay = day
        try {
            const bak = createConfigBackup()
            api.log('[repair] automatic config backup:', bak)
        } catch (e) {
            api.log('[repair] automatic config backup failed:', e.message)
        }
    }

    
    
    
    function livePluginsConfig() {
        try { return api.getHfsConfig('plugins_config') } catch { return null }
    }
    function liveEnableList() {
        try { return api.getHfsConfig('enable_plugins') } catch { return null }
    }
    function syncLiveConfig(plan) {
        const live = livePluginsConfig()
        if (live && typeof live === 'object' && !Array.isArray(live)) {
            for (const m of plan.merges || []) {
                if (!(m.from in live)) continue
                const dst = live[m.to] && typeof live[m.to] === 'object' ? live[m.to] : {}
                for (const [k, v] of Object.entries(live[m.from] || {}))
                    if (!(k in dst)) dst[k] = v
                live[m.to] = dst
                delete live[m.from]
            }
            for (const r of plan.renames || []) {
                if (!(r.from in live) || live[r.from] == null) continue
                live[r.to] = live[r.from]
                delete live[r.from]
            }
            for (const k of plan.removed || []) delete live[k]
            for (const k of plan.removedKeys || []) {
                if (live[k.section] && typeof live[k.section] === 'object')
                    delete live[k.section][k.key]
            }
        }
        const list = liveEnableList()
        if (Array.isArray(list)) {
            for (let i = 0; i < list.length; i++) {
                const map = plan.enableRename || {}
                if (map[String(list[i])]) list[i] = map[String(list[i])]
            }
            const remove = new Set(plan.enableRemove || [])
            for (let i = list.length - 1; i >= 0; i--) {
                if (remove.has(String(list[i]))) list.splice(i, 1)
            }
            const seen = new Set()
            for (let i = list.length - 1; i >= 0; i--) {
                const v = String(list[i])
                if (seen.has(v)) list.splice(i, 1)
                seen.add(v)
            }
        }
    }

    
    
    
    let onlineState = { entries: [], source: 'none', updatedAt: null, error: null, loading: null }
    let repoCache = readJsonFile(REPO_CACHE, { repos: {} })
    if (!repoCache || typeof repoCache !== 'object') repoCache = { repos: {} }
    if (!repoCache.repos || typeof repoCache.repos !== 'object') repoCache.repos = {}
    if (!repoCache.hfsPrefix || typeof repoCache.hfsPrefix !== 'object') repoCache.hfsPrefix = {}
    const repoCacheDirty = { value: false }

    function splitRepo(repo) {
        const s = String(repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '')
        const i = s.indexOf('/')
        if (i < 0) return { owner: '', name: s }
        return { owner: s.slice(0, i), name: s.slice(i + 1).split('/')[0] }
    }
    const sameOwner = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase()
        || (OWNER_ALIASES.has(String(a || '').toLowerCase()) && OWNER_ALIASES.has(String(b || '').toLowerCase()))
    const normOwner = o => OWNER_ALIASES.has(String(o || '').toLowerCase()) ? CANONICAL_OWNER : String(o || '')

    
    function repoVariants(repo) {
        const { owner, name } = splitRepo(repo)
        if (!owner || !name) return []
        const owners = []
        if (OWNER_ALIASES.has(owner.toLowerCase())) owners.push(CANONICAL_OWNER, owner, 'Hug3O', 'Hugo29100')
        else owners.push(owner)
        const names = [name]
        if (/^hfs-/i.test(name)) names.push(name.replace(/^hfs-/i, ''))
        else names.push('hfs-' + name)
        const out = []
        const seen = new Set()
        for (const o of owners) {
            for (const n of names) {
                const candidate = `${o}/${n}`
                if (seen.has(candidate.toLowerCase())) continue
                seen.add(candidate.toLowerCase())
                out.push(candidate)
            }
        }
        return out
    }

    function normalizeName(name) {
        return String(name || '')
            .toLowerCase()
            .replace(/^hugo529100[-_]/, '')
            .replace(/^hugo29100[-_]/, '')
            .replace(/^hug3o[-_]/, '')
            .replace(/^hfs[-_]/, '')
            .replace(/[-_](main|master)$/, '')
            .replace(/\+$/, '')
            .replace(/[^a-z0-9]/g, '')
    }

    async function readMirror() {
        const data = readJsonFile(MIRROR_FILE, null)
        if (!data || !Array.isArray(data.entries)) return null
        return {
            entries: data.entries.map(e => ({
                id: e.id || e.repo,
                repo: e.repo || e.id,
                version: e.version ?? null,
                apiRequired: e.apiRequired ?? null,
                description: e.description || '',
                branch: e.branch || e.default_branch || 'main',
                default_branch: e.default_branch || e.branch || 'main',
                pushed_at: e.pushed_at || null,
            })),
            updatedAt: data.updatedAt || null,
            source: 'optimizer',
        }
    }

    
    
    
    
    const OPTIMIZER_CACHE_BUST = new Set(['t', '_', 'timestamp', 'cachebust', 'v', 'ver', 'version'])
    function optimizerNormalizeEnabled() {
        try {
            const cfg = api.getHfsConfig('plugins_config')?.['Plugins-Optimizer']
            if (cfg && Object.prototype.hasOwnProperty.call(cfg, 'normalizeUrl')) return !!cfg.normalizeUrl
        } catch {}
        return true
    }
    function optimizerNormalizeUrl(rawUrl) {
        if (!optimizerNormalizeEnabled()) return rawUrl
        try {
            const u = new URL(rawUrl)
            for (const p of [...u.searchParams.keys()])
                if (OPTIMIZER_CACHE_BUST.has(p.toLowerCase())) u.searchParams.delete(p)
            u.searchParams.sort()
            let pathname = u.pathname.replace(/\/+$/, '')
            if (!pathname) pathname = '/'
            u.pathname = pathname
            return u.toString()
        } catch { return rawUrl }
    }
    function optimizerCacheKey(url, method = 'GET') {
        return crypto.createHash('sha1')
            .update(`${method} ${optimizerNormalizeUrl(url)}`)
            .digest('hex').slice(0, 16)
    }
    function readOptimizerCache(url, method = 'GET', maxAgeMs = 6 * 3600 * 1000) {
        try {
            const dir = path.join(OPTIMIZER_CACHE_DIR, optimizerCacheKey(url, method))
            const meta = readJsonFile(path.join(dir, 'meta.json'), null)
            if (!meta || meta.source === 'ratelimit') return null
            const status = Number(meta.statusCode) || 0
            if (status < 200 || status >= 300) return null
            if (Date.now() - (Number(meta.fetchedAt) || 0) > maxAgeMs) return null
            const body = fs.readFileSync(path.join(dir, 'body.bin'), 'utf8')
            if (!body) return null
            return { status, body, meta, cached: true }
        } catch { return null }
    }

    
    
    
    function optimizerPluginCacheIndex(maxAgeMs = 6 * 3600 * 1000) {
        const out = new Map()
        try {
            for (const name of fs.readdirSync(OPTIMIZER_CACHE_DIR)) {
                const dir = path.join(OPTIMIZER_CACHE_DIR, name)
                try {
                    const meta = readJsonFile(path.join(dir, 'meta.json'), null)
                    if (!meta || meta.source === 'ratelimit') continue
                    const status = Number(meta.statusCode) || 0
                    if (status < 200 || status >= 300) continue
                    if (Date.now() - (Number(meta.fetchedAt) || 0) > maxAgeMs) continue
                    if ((Number(meta.bodyLength) || 0) > 2 * 1024 * 1024) continue
                    const body = fs.readFileSync(path.join(dir, 'body.bin'), 'utf8')
                    if (!body.includes('exports.version') || !body.includes('exports.repo')) continue
                    const parsed = parsePluginMeta(body)
                    const repo = String(parsed.repo || '').toLowerCase()
                    if (!repo) continue
                    const entry = {
                        repo: parsed.repo,
                        version: parsed.version,
                        apiRequired: parsed.apiRequired,
                        fetchedAt: Number(meta.fetchedAt) || 0,
                        cached: true,
                    }
                    const prev = out.get(repo)
                    if (!prev || entry.fetchedAt > prev.fetchedAt) out.set(repo, entry)
                } catch {}
            }
        } catch {}
        return out
    }

    function httpsText(url, { timeout = 15000, headers = {}, signal = null } = {}) {
        return new Promise(resolve => {
            let settled = false
            let onAbort = null
            const done = v => {
                if (settled) return
                settled = true
                if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort) } catch {} }
                resolve(v)
            }
            if (signal?.aborted) return done({ status: 0, body: '', error: 'aborted' })
            try {
                const req = https.get(url, {
                    headers: {
                        'user-agent': 'HFS-Plugins-Repair',
                        'accept': 'application/vnd.github.v3+json, application/json, text/plain, */*',
                        ...headers,
                    },
                    timeout,
                }, res => {
                    const chunks = []
                    let total = 0
                    res.on('data', c => {
                        total += c.length
                        if (total > 4 * 1024 * 1024) { try { req.destroy() } catch {}; done({ status: 0, body: '', error: 'response too large' }); return }
                        chunks.push(c)
                    })
                    res.on('end', () => done({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }))
                    res.on('error', e => done({ status: 0, body: '', error: e.message }))
                })
                if (signal) {
                    onAbort = () => { try { req.destroy() } catch {}; done({ status: 0, body: '', error: 'aborted' }) }
                    signal.addEventListener('abort', onAbort, { once: true })
                }
                req.on('timeout', () => { try { req.destroy() } catch {}; done({ status: 0, body: '', error: 'timeout' }) })
                req.on('error', e => done({ status: 0, body: '', error: e.message }))
            } catch (e) { done({ status: 0, body: '', error: e.message }) }
        })
    }

    
    
    async function fetchOwnerRepos(owner) {
        const cache = readJsonFile(OWNER_CACHE, { owners: {} })
        const key = String(owner || '').toLowerCase()
        const cached = cache.owners?.[key]
        if (cached && Array.isArray(cached.repos) && Date.now() - (cached.updatedAt || 0) < 6 * 3600 * 1000)
            return cached.repos
        const repos = []
        try {
            const escaped = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            for (let page = 1; page <= 5; page++) {
                const r = await httpsText(`https://github.com/${encodeURIComponent(owner)}?tab=repositories&page=${page}`, { timeout: 12000 })
                if (r.status !== 200 || !r.body) break
                const re = new RegExp(`href="/${escaped}/([^"\\/?#]+)"`, 'gi')
                let m
                let added = 0
                while ((m = re.exec(r.body))) {
                    const repo = m[1]
                    if (repos.some(x => x.toLowerCase() === repo.toLowerCase())) continue
                    repos.push(repo)
                    added++
                }
                if (!added) break
            }
        } catch {}
        cache.owners = cache.owners || {}
        cache.owners[key] = { updatedAt: Date.now(), repos }
        writeJsonFile(OWNER_CACHE, cache)
        return repos
    }

    async function githubSearch() {        const repos = []
        for (let page = 1; page <= 3; page++) {
            const r = await httpsText(`https://api.github.com/search/repositories?q=topic:hfs-plugin&per_page=100&page=${page}`)
            if (r.status !== 200) return { error: r.error || ('HTTP ' + r.status), repos }
            let json
            try { json = JSON.parse(r.body) } catch { return { error: 'bad JSON', repos } }
            const items = Array.isArray(json.items) ? json.items : []
            repos.push(...items)
            if (items.length < 100 || repos.length >= (json.total_count || 0)) break
        }
        return {
            entries: repos.map(r => ({
                id: r.full_name,
                repo: r.full_name,
                version: null,
                apiRequired: null,
                description: r.description || '',
                branch: r.default_branch || 'main',
                default_branch: r.default_branch || 'main',
                pushed_at: r.pushed_at || null,
                license: r.license?.spdx_id || null,
            })),
        }
    }

    async function readNativeCatalog() {
        try {
            const mod = api.require('./pluginCatalog')
            if (!mod?.getPluginCatalog) return null
            const it = mod.getPluginCatalog()
            const first = await it.next()
            if (first.done || !first.value) return null
            const snapshot = first.value
            const entries = []
            for (const row of snapshot.entries || []) {
                const pl = row?.plugin
                const repo = row?.repository?.full_name || pl?.repo
                if (!pl || !repo) continue
                entries.push({
                    id: repo,
                    repo,
                    version: pl.version ?? null,
                    apiRequired: pl.apiRequired ?? null,
                    description: pl.description || row.repository?.description || '',
                    branch: pl.branch || row.repository?.default_branch || 'main',
                    default_branch: row.repository?.default_branch || pl.branch || 'main',
                    pushed_at: row.repository?.pushed_at || null,
                })
            }
            return { entries, updatedAt: Number(snapshot.updatedAt) || null, source: 'HFS native catalog' }
        } catch { return null }
    }

    async function loadOnlineCatalog({ refresh = false, search = true } = {}) {
        if (onlineState.loading) return onlineState.loading
        onlineState.loading = (async () => {
            const cached = onlineState.entries.length ? { entries: onlineState.entries, updatedAt: onlineState.updatedAt, source: onlineState.source } : null
            if (cached && !refresh) return cached

            const mirror = await readMirror()
            let entries = mirror?.entries || []
            let source = mirror ? 'optimizer' : 'none'
            let updatedAt = mirror?.updatedAt || null
            let error = null

            const cache = readJsonFile(ONLINE_CACHE, null)
            if (cache && Array.isArray(cache.entries)) {
                
                const byId = new Map(cache.entries.map(e => [String(e.repo || e.id).toLowerCase(), e]))
                for (const e of entries) byId.set(String(e.repo || e.id).toLowerCase(), e)
                entries = [...byId.values()]
                if (source === 'none') { source = 'cache'; updatedAt = cache.updatedAt || null }
            }

            
            
            const native = await readNativeCatalog()
            if (native?.entries?.length && native.updatedAt && (!updatedAt || native.updatedAt > updatedAt)) {
                entries = native.entries
                source = 'HFS native catalog'
                updatedAt = native.updatedAt
            }

            
            
            if (refresh && search) {
                const searchResult = await githubSearch()
                if (searchResult.entries?.length) {
                    const byId = new Map(entries.map(e => [String(e.repo || e.id).toLowerCase(), e]))
                    for (const e of searchResult.entries) if (!byId.has(e.repo.toLowerCase())) byId.set(e.repo.toLowerCase(), e)
                    entries = [...byId.values()]
                    source = source === 'optimizer' ? 'optimizer+github' : 'github'
                    updatedAt = Date.now()
                    writeJsonFile(ONLINE_CACHE, { version: 1, updatedAt, entries })
                } else if (searchResult.error) error = searchResult.error
            }

            onlineState = { entries, source, updatedAt, error, loading: null }
            return { entries, updatedAt, source, error }
        })()
        try { return await onlineState.loading } finally { onlineState.loading = null }
    }

    function onlineIndex(entries) {
        const byRepo = new Map()
        const byNorm = new Map()
        for (const e of entries) {
            const repo = String(e.repo || e.id || '')
            byRepo.set(repo.toLowerCase(), e)
            const n = normalizeName(splitRepo(repo).name)
            if (!n) continue
            const list = byNorm.get(n) || []
            list.push(e)
            byNorm.set(n, list)
        }
        return { byRepo, byNorm }
    }

    function pickOnline(index, folder, repo) {
        const { owner, name } = splitRepo(repo)
        const folderNorm = normalizeName(folder)
        const repoNorm = normalizeName(name)
        const candidates = []
        const add = (e, why) => {
            if (!e || candidates.some(c => c.entry === e && c.why === why)) return
            candidates.push({ entry: e, why })
        }
        if (repo) add(index.byRepo.get(String(repo).toLowerCase()), 'repo')
        for (const e of index.byNorm.get(folderNorm) || []) add(e, 'folder')
        for (const e of index.byNorm.get(repoNorm) || []) add(e, 'name')

        let best = null
        const ties = []
        for (const c of candidates) {
            const e = c.entry
            const eRepo = String(e.repo || e.id)
            const eName = splitRepo(eRepo).name
            const eOwner = splitRepo(eRepo).owner
            let score = 0
            if (repo && eRepo.toLowerCase() === String(repo).toLowerCase()) score += 100
            if (sameOwner(eOwner, owner)) score += 30
            
            if (normalizeName(eName) === folderNorm && folderNorm) score += 60
            if (normalizeName(eName) === repoNorm && repoNorm) score += 40
            if (String(eOwner).toLowerCase() === CANONICAL_OWNER) score += 3
            const cand = { entry: e, score, why: c.why }
            if (!best || cand.score > best.score) { best = cand; ties.length = 0 }
            else if (cand.score === best.score && String(best.entry.repo).toLowerCase() !== eRepo.toLowerCase()) {
                if (!ties.some(t => t.toLowerCase() === eRepo.toLowerCase())) ties.push(eRepo)
            }
        }
        if (!best || best.score < 35) return null
        if (ties.length) best.ambiguous = ties
        return best
    }

    async function checkRepo(repo, { force = false, optimizerIndex = null, candidateRepo = null, signal = null } = {}) {
        const key = String(repo || '').toLowerCase()
        if (!key) return null
        const cached = repoCache.repos[key]
        if (!force && cached && Date.now() - (cached.checkedAt || 0) < 6 * 3600 * 1000) return cached
        const { owner, name } = splitRepo(repo)
        if (!owner || !name) return null
        if (optimizerIndex) {
            const hit = optimizerIndex.get(String(repo).toLowerCase())
            if (hit) {
                const out = {
                    checkedAt: Date.now(),
                    requestedRepo: repo,
                    repo,
                    exists: true,
                    version: hit.version,
                    apiRequired: hit.apiRequired,
                    defaultBranch: null,
                    error: null,
                    cached: true,
                    cacheSource: 'optimizer',
                }
                repoCache.repos[key] = out
                repoCacheDirty.value = true
                return out
            }
        }
        const out = {
            checkedAt: Date.now(),
            requestedRepo: repo,
            repo,
            exists: false,
            version: null,
            apiRequired: null,
            defaultBranch: null,
            error: null,
            cached: false,
        }
        
        
        
        for (const candidate of (candidateRepo
            ? [candidateRepo, ...repoVariants(repo).filter(v => v.toLowerCase() !== candidateRepo.toLowerCase())]
            : repoVariants(repo))) {
            for (const branch of ['main', 'master']) {
                for (const file of ['plugin.js', 'dist/plugin.js']) {
                    const url = `https://raw.githubusercontent.com/${candidate}/${branch}/${file}`
                    const cachedRaw = readOptimizerCache(url)
                    if (cachedRaw) out.cached = true
                    const raw = cachedRaw || await httpsText(url, { timeout: 8000, signal })
                    if (raw.status !== 200 || !raw.body) continue
                    const meta = parsePluginMeta(raw.body)
                    out.exists = true
                    out.repo = candidate
                    out.metaRepo = meta.repo || ''
                    out.version = meta.version
                    out.apiRequired = meta.apiRequired
                    out.branch = branch
                    out.file = file
                    if (candidate.toLowerCase() !== repo.toLowerCase())
                        out.suggestedRepo = candidate
                    repoCache.repos[key] = out
                    repoCacheDirty.value = true
                    return out
                }
            }
        }
        out.error = 'plugin.js not found'
        repoCache.repos[key] = out
        repoCacheDirty.value = true
        return out
    }

    async function deepCheck(items, job) {
        const unique = [...new Set(items.map(i => i.target.repo || i.repo).filter(Boolean))]
        jobLog(job, 'dim', `Deep check: ${unique.length} repositories (raw plugin.js probes, Plugins-Optimizer cache/proxy preferred)`)
        let done = 0
        let cacheHits = 0
        const optimizerIndex = optimizerPluginCacheIndex()
        if (optimizerIndex.size)
            jobLog(job, 'dim', `Plugins-Optimizer cache index: ${optimizerIndex.size} plugin.js repositories`)
        const ownerIndex = new Map()
        try {
            const owned = await fetchOwnerRepos(CANONICAL_OWNER)
            for (const name of owned) {
                const norm = normalizeName(name)
                if (norm) ownerIndex.set(norm, `${CANONICAL_OWNER}/${name}`)
            }
            if (ownerIndex.size)
                jobLog(job, 'dim', `Owner repo index: ${ownerIndex.size} public repositories under ${CANONICAL_OWNER}`)
        } catch {}
        const itemByRepo = new Map()
        for (const it of items) {
            const r = it.target?.repo || it.repo
            if (r && !itemByRepo.has(r)) itemByRepo.set(r, it)
        }
        const queue = unique.slice()
        const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
            while (queue.length) {
                const repo = queue.shift()
                if (job.cancelRequested) throw Error('Aborted by user')
                const ownerLower = splitRepo(repo).owner.toLowerCase()
                const meta = itemByRepo.get(repo)
                const candidateRepo = (ownerIndex.size && (OWNER_ALIASES.has(ownerLower) || ownerLower === CANONICAL_OWNER))
                    ? (ownerIndex.get(normalizeName(splitRepo(repo).name))
                        || (meta ? ownerIndex.get(normalizeName(meta.folder)) : null))
                    : null
                const res = await checkRepo(repo, { optimizerIndex, force: true, candidateRepo, signal: job.signal })
                    .catch(e => ({ error: e.message, exists: false }))
                if (res && res.cached) cacheHits++
                if (res && !res.exists) {
                    const { owner, name } = splitRepo(repo)
                    if (owner && name && !/^hfs-/i.test(name)) {
                        const hfsRepo = `${owner}/hfs-${name}`
                        const hfsRes = await checkRepo(hfsRepo, { optimizerIndex, force: true, signal: job.signal })
                            .catch(() => null)
                        if (hfsRes?.exists) repoCache.hfsPrefix[repo.toLowerCase()] = hfsRepo
                    }
                }
                done++
                if (done % 20 === 0) jobLog(job, 'dim', `Deep check ${done}/${unique.length} ...`)
            }
        })
        await Promise.all(workers)
        writeJsonFile(REPO_CACHE, repoCache)
        jobLog(job, 'dim', `Deep check done (${unique.length} repositories, ${cacheHits} served from Plugins-Optimizer cache)`)
    }

    
    
    
    
    
    const declaredKeysCache = new Map()
    function pluginDeclaredKeys(folder) {
        const file = path.join(PLUGINS_ROOT, folder, 'plugin.js')
        let mtime = 0
        try { mtime = fs.statSync(file).mtimeMs } catch { return null }
        const cached = declaredKeysCache.get(folder)
        if (cached && cached.mtime === mtime) return cached.keys
        let keys = null
        try {
            try { delete require.cache[require.resolve(file)] } catch {}
            const mod = require(file)
            const def = mod?.config
            if (typeof def === 'function') {
                const fields = def({})
                if (fields && typeof fields === 'object') keys = new Set(Object.keys(fields))
            } else if (def && typeof def === 'object') {
                keys = new Set(Object.keys(def))
            }
        } catch {}
        declaredKeysCache.set(folder, { mtime, keys })
        return keys
    }

    function parsePluginMeta(source) {        const text = String(source || '').replace(/^\uFEFF/, '')
        const pick = re => {
            const m = text.match(re)
            if (!m) return undefined
            let v = m[1].trim()
            v = v.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
            v = v.replace(/^['"`]|['"`]$/g, '').trim()
            return v
        }
        const version = pick(/exports\.version\s*=\s*([^\r\n;]+)/)
        const apiRequired = pick(/exports\.apiRequired\s*=\s*([^\r\n;]+)/)
        const repo = pick(/exports\.repo\s*=\s*([^\r\n;]+)/)
        return { repo: repo || '', version: version ?? null, apiRequired: apiRequired ?? null, source: text }
    }
    function numericVersion(v) {
        if (v === null || v === undefined || v === '') return null
        const m = String(v).trim().replace(/^v/i, '').match(/^(\d+(?:\.\d+)*)/)
        if (!m) return null
        return m[1].split('.').map(Number)
    }
    function compareVersion(a, b) {
        const A = numericVersion(a), B = numericVersion(b)
        if (!A || !B) return null
        const n = Math.max(A.length, B.length)
        for (let i = 0; i < n; i++) {
            const x = A[i] || 0, y = B[i] || 0
            if (x !== y) return x < y ? -1 : 1
        }
        return 0
    }

    
    
    
    function readConfigModel() {
        if (!exists(CONFIG_PATH)) return null
        const text = readText(CONFIG_PATH).replace(/^\uFEFF/, '')
        return { text, doc: parseDoc(text), path: CONFIG_PATH }
    }

    function ignoredFolderSet() {
        let raw = 'Backup,PATCH'
        try {
            const value = api.getConfig('ignoreFolders')
            if (value !== undefined && value !== null) raw = value
        } catch {}
        const parts = Array.isArray(raw) ? raw : String(raw).split(',')
        return new Set(parts.map(s => String(s).trim().toLowerCase()).filter(Boolean))
    }

    function ignoredPluginSet() {
        let raw = ''
        try {
            const value = api.getConfig('ignorePlugins')
            if (value !== undefined && value !== null) raw = value
        } catch {}
        const parts = Array.isArray(raw) ? raw : String(raw).split(',')
        return new Set(parts.map(s => String(s).trim().toLowerCase()).filter(Boolean))
    }

    function pluginSettings() {
        const readString = (key, def = '') => {
            try {
                const v = api.getConfig(key)
                return v === undefined || v === null ? def : String(v).trim()
            } catch { return def }
        }
        return {
            backupTime: readString('backupTime'),
            backupLimit: Math.min(500, Math.max(5, Number(api.getConfig('backupLimit')) || 30)),
            ignoreFolders: readString('ignoreFolders', 'Backup,PATCH'),
            ignorePlugins: readString('ignorePlugins'),
            debug: api.getConfig('debug') === true || api.getConfig('debug') === 'true' || api.getConfig('debug') === 1,
        }
    }

    function makeItem(folder, ctx) {
        const dir = path.join(PLUGINS_ROOT, folder)
        const item = {
            id: folder,
            folder,
            dir,
            repo: '',
            repoOwner: '',
            repoName: '',
            version: null,
            apiRequired: null,
            mtime: null,
            hasPluginJs: false,
            broken: false,
            error: '',
            target: { id: folder, repo: '', source: 'none', confidence: 'none' },
            config: { status: 'none', key: null, variants: [], preview: null },
            enable: { status: 'none', entries: [], entry: null },
            online: null,
            running: ctx.running.has(folder),
            tags: [],
            severity: 'healthy',
            fixes: [],
            notes: [],
            decision: ctx.decisions[folder] || 'fix',
        }

        const pluginFile = path.join(dir, 'plugin.js')
        if (!exists(pluginFile)) {
            item.tags.push('no-plugin-js')
            item.severity = 'unhealthy'
            item.notes.push('plugin.js is missing; this may not be a plugin folder (backup, leftover or tool directory). Check its contents before deleting.')
            return item
        }
        let meta
        try { meta = parsePluginMeta(readText(pluginFile)) } catch (e) {
            item.broken = true
            item.error = e.message
            item.tags.push('broken-plugin-js')
            item.severity = 'unhealthy'
            item.notes.push('Failed to read plugin.js: ' + e.message)
            return item
        }
        item.hasPluginJs = true
        item.version = meta.version
        item.apiRequired = meta.apiRequired
        item.mtime = ctx.folderMeta.get(folder)?.mtime || null
        item.repo = String(meta.repo || '').trim()
        const { owner, name } = splitRepo(item.repo)
        item.repoOwner = owner
        item.repoName = name
        if (!item.repo) {
            item.tags.push('no-repo')
            item.notes.push('plugin.js does not declare exports.repo')
        }

        
        
        
        
        const picked = item.repo ? pickOnline(ctx.index, folder, item.repo) : null
        if (picked) {
            const e = picked.entry
            const eRepo = String(e.repo || e.id)
            const repoName = splitRepo(eRepo).name
            const targetId = repoName.replace(/^hfs-/, '') || repoName
            item.target = {
                id: targetId,
                repo: eRepo,
                source: picked.why,
                confidence: picked.ambiguous ? 'ambiguous' : (String(eRepo).toLowerCase() === item.repo.toLowerCase() ? 'exact' : 'alias'),
                onlineId: e.id,
            }
            if (picked.ambiguous) {
                item.tags.push('online-ambiguous')
                item.notes.push('Multiple online candidates with the same name: ' + [eRepo, ...picked.ambiguous].join(', '))
            }
        } else {
            item.target = { id: folder, repo: item.repo, source: 'none', confidence: 'none' }
        }
        
        
        
        if (item.repo) {
            const { owner, name } = splitRepo(item.repo)
            if (owner && name && !/^hfs-/i.test(name)) {
                const hfsRepo = `${owner}/hfs-${name}`
                const hfsEntry = ctx.index?.byRepo?.get(hfsRepo.toLowerCase())
                if (hfsEntry) {
                    item.target = {
                        id: name,
                        repo: String(hfsEntry.repo || hfsEntry.id || hfsRepo),
                        source: 'hfs-prefix',
                        confidence: 'alias',
                        onlineId: hfsEntry.id,
                    }
                    item.tags.push('repo-missing-hfs')
                    item.notes.push(`Repository uses the hfs- convention: ${hfsRepo}`)
                }
            }
        }
        
        
        if (item.target.source === 'none' && item.repo) {
            const deep = repoCache.repos[String(item.repo).toLowerCase()]
            if (deep?.exists && deep.repo && deep.repo.toLowerCase() !== item.repo.toLowerCase()) {
                const repoName = splitRepo(deep.repo).name
                const targetId = repoName.replace(/^hfs-/, '') || repoName
                item.target = { id: targetId, repo: deep.repo, source: 'deep', confidence: 'alias' }
                item.notes.push(`Online probe found ${deep.repo}${deep.version != null ? ' (v' + deep.version + ')' : ''}`)
            }
            const hfsRepo = repoCache.hfsPrefix[String(item.repo).toLowerCase()]
            if (hfsRepo) {
                const repoName = splitRepo(hfsRepo).name
                item.target = { id: repoName.replace(/^hfs-/, '') || repoName, repo: hfsRepo, source: 'deep-hfs', confidence: 'alias' }
                item.tags.push('repo-missing-hfs')
                item.notes.push(`Deep probe found the hfs- repository ${hfsRepo}`)
            }
        }

        
        const targetRepo = item.target.source !== 'none'
            ? item.target.repo
            : (item.repoOwner ? normOwner(item.repoOwner) + '/' + item.repoName : item.repo)
        if (targetRepo && targetRepo !== item.repo) {
            const targetName = splitRepo(targetRepo).name
            const sameName = targetName.toLowerCase() === item.repoName.toLowerCase()
            const ownerAlias = sameName
                && normOwner(splitRepo(targetRepo).owner).toLowerCase() === CANONICAL_OWNER
                && item.repoOwner.toLowerCase() !== CANONICAL_OWNER
            if (ownerAlias) item.tags.push('repo-owner-alias')
            else if (sameName) item.tags.push('repo-case-mismatch')
            else item.tags.push('repo-name-mismatch')
            item.fixes.push({
                type: 'repo',
                auto: true,
                label: item.tags.includes('repo-missing-hfs') ? 'Fix missing hfs- prefix'
                    : ownerAlias ? 'Fix repo owner' : 'Fix exports.repo',
                before: item.repo,
                after: targetRepo,
                detail: ownerAlias
                    ? `Change exports.repo owner ${item.repoOwner} to ${CANONICAL_OWNER} (alias)`
                    : `Correct exports.repo to the online repository ${targetRepo}`,
            })
        }

        
        if (item.target.source !== 'none') {
            if (item.target.id !== folder) {
                const caseOnly = item.target.id.toLowerCase() === folder.toLowerCase()
                item.tags.push(caseOnly ? 'folder-case-mismatch' : 'folder-name-mismatch')
                item.fixes.push({
                    type: 'rename',
                    auto: !caseOnly,
                    optional: caseOnly,
                    risk: caseOnly ? 'low' : (item.running ? 'high' : 'medium'),
                    label: caseOnly ? 'Normalize name case' : 'Rename folder to GitHub install name',
                    before: folder,
                    after: item.target.id,
                    detail: caseOnly
                        ? `Folder ${folder} differs from install name ${item.target.id} only by case`
                        : `Folder ${folder} → ${item.target.id} (settings migrate with it; HFS reloads automatically)`,
                    requiresStop: item.running,
                })
            }
        } else if (item.repoName && item.repoName.toLowerCase() === folder.toLowerCase() && item.repoName !== folder) {
            item.tags.push('folder-case-mismatch')
            item.notes.push(`Folder ${folder} and exports.repo name ${item.repoName} differ only by case (no online data; rename skipped)`)
        } else if (item.repoName && folder !== item.repoName && normalizeName(item.repoName) !== normalizeName(folder)) {
            item.tags.push('folder-name-differs')
            item.notes.push(`Folder name ${folder} differs from repository name ${item.repoName}`)
        }

        
        const onlineKey = String(item.target.repo || item.repo || '').toLowerCase()
        const onlineVersion = ctx.onlineByRepo.get(onlineKey)?.version
            ?? ctx.onlineByRepo.get(String(item.repo).toLowerCase())?.version
            ?? null
        const checked = repoCache.repos[onlineKey] || repoCache.repos[String(item.repo).toLowerCase()]
        const liveVersion = checked && checked.exists ? checked.version : null
        item.online = {
            id: item.target.onlineId || null,
            version: liveVersion != null ? liveVersion : onlineVersion,
            live: !!(checked && checked.exists),
            exists: checked ? !!checked.exists : (item.target.source !== 'none'),
            error: checked?.error || null,
        }
        if (item.online.error && /not found|404/i.test(item.online.error))
            item.tags.push('online-not-found')
        const cmp = compareVersion(item.version, item.online.version)
        if (cmp === 1) {
            item.tags.push('local-newer')
            
            item.tags.push('not-published')
            
            
            if (item.online.version != null && String(item.online.version) !== String(item.version)) {
                const updateRepo = checked?.repo || item.target.repo || item.repo
                const urls = []
                const addUrl = (repo, branch, file) => {
                    if (!repo) return
                    const u = `https://raw.githubusercontent.com/${repo}/${branch}/${file}`
                    if (!urls.includes(u)) urls.push(u)
                }
                if (checked?.branch && checked?.file) addUrl(updateRepo, checked.branch, checked.file)
                for (const branch of [checked?.branch, 'main', 'master'].filter(Boolean))
                    for (const file of ['dist/plugin.js', 'plugin.js']) addUrl(updateRepo, branch, file)
                if (urls.length) {
                    item.fixes.push({
                        type: 'update',
                        force: true,
                        optional: true,
                        auto: false,
                        label: `Use online v${item.online.version}`,
                        before: item.version,
                        after: item.online.version,
                        repo: updateRepo,
                        branch: checked?.branch || 'main',
                        file: checked?.file || 'plugin.js',
                        urls,
                        detail: `Replace local v${item.version} with the online v${item.online.version} after a backup`,
                    })
                }
            }
        } else if (cmp === 0) {
            const updateRepo = checked?.repo || item.target.repo || item.repo
            const urls = []
            const addUrl = (repo, branch, file) => {
                if (!repo) return
                const u = `https://raw.githubusercontent.com/${repo}/${branch}/${file}`
                if (!urls.includes(u)) urls.push(u)
            }
            if (checked?.branch && checked?.file) addUrl(updateRepo, checked.branch, checked.file)
            for (const branch of [checked?.branch, 'main', 'master'].filter(Boolean))
                for (const file of ['dist/plugin.js', 'plugin.js']) addUrl(updateRepo, branch, file)
            if (item.online.version != null && urls.length) {
                item.fixes.push({
                    type: 'update',
                    reinstall: true,
                    auto: false,
                    optional: true,
                    label: `Reinstall online v${item.online.version}`,
                    before: item.version,
                    after: item.online.version,
                    repo: updateRepo,
                    branch: checked?.branch || 'main',
                    file: checked?.file || 'plugin.js',
                    urls,
                    detail: `Download a fresh plugin.js v${item.online.version} from ${updateRepo}, replace the local file and keep a backup`,
                })
            }
        } else if (cmp === -1) {
            item.tags.push('local-older')
            item.tags.push('update-available')
            const updateRepo = checked?.repo || item.target.repo || item.repo
            const urls = []
            const addUrl = (repo, branch, file) => {
                if (!repo) return
                const u = `https://raw.githubusercontent.com/${repo}/${branch}/${file}`
                if (!urls.includes(u)) urls.push(u)
            }
            if (checked?.branch && checked?.file) addUrl(updateRepo, checked.branch, checked.file)
            for (const branch of [checked?.branch, 'main', 'master'].filter(Boolean))
                for (const file of ['dist/plugin.js', 'plugin.js']) addUrl(updateRepo, branch, file)
            if (urls.length) {
                item.fixes.push({
                    type: 'update',
                    auto: true,
                    label: `Update v${item.version} → v${item.online.version}`,
                    before: item.version,
                    after: item.online.version,
                    repo: updateRepo,
                    branch: checked?.branch || 'main',
                    file: checked?.file || 'plugin.js',
                    urls,
                    detail: `Download plugin.js v${item.online.version} from ${updateRepo} and back up the local v${item.version}`,
                })
                item.notes.push(`Online v${item.online.version} is newer than local v${item.version}; an update fix is available`)
            }
        }

        
        const cfg = ctx.config
        if (cfg) {
            const targetId = item.target.id || folder
            const renameTarget = item.target.source !== 'none' && targetId !== folder
            const exact = cfg.sections.find(s => s.key === folder)
            const caseVariant = cfg.sections.filter(s => s.key !== folder && s.key.toLowerCase() === folder.toLowerCase())
            const alias = cfg.sections.filter(s => {
                if (s.key === folder || s.key.toLowerCase() === folder.toLowerCase()) return false
                const n = normalizeName(s.key)
                if (!n) return false
                if (n !== normalizeName(folder) && n !== normalizeName(targetId)) return false
                
                return !ctx.folders.some(f => f !== folder && f === s.key)
            })
            let variants = [...caseVariant, ...alias]
            item.config.key = exact ? exact.key : (variants[0]?.key || null)
            item.config.status = exact ? 'exact' : (caseVariant.length ? 'case' : (alias.length ? 'alias' : 'none'))
            item.config.targetKey = targetId
            const targetExists = !!cfg.sections.find(s => s.key === targetId)
            const settings = analyzeSettings(cfg, folder, exact, variants, targetId, ctx)
            item.settings = settings
            
            
            if (!exact && settings.masterKey) {
                variants = [...variants].sort((a, b) =>
                    a.key === settings.masterKey ? -1 : b.key === settings.masterKey ? 1 : 0)
            }
            item.config.variants = variants.map(s => s.key)
            item.config.masterKey = settings.masterKey
            const renameFrom = exact && renameTarget && !targetExists ? exact.key : null
            const mergeFrom = [
                ...variants.map(v => v.key),
                ...(exact && targetExists && exact.key !== targetId ? [exact.key] : []),
            ].filter(k => k !== targetId)
            if (renameFrom || mergeFrom.length) {
                if (mergeFrom.length) item.tags.push('config-variant')
                else if (renameTarget) item.tags.push('config-rename')
                const masterNote = settings.masterKey
                    ? ` Master: ${settings.masterKey}${settings.masterVersion != null ? ' (v' + settings.masterVersion + ')' : ''}${settings.masterMtime ? ' · ' + fmtStamp(settings.masterMtime) : ''}.`
                    : ''
                item.fixes.push({
                    type: 'config',
                    auto: true,
                    label: renameTarget ? 'Migrate config.yaml settings (rename)' : 'Merge duplicate config.yaml settings',
                    before: [renameFrom, ...mergeFrom].filter(Boolean).join(' + '),
                    after: targetId,
                    detail: `Migrate settings of ${[renameFrom, ...mergeFrom].filter(Boolean).join(', ')} to ${targetId}; master values win and other keys are preserved.${masterNote}`,
                    ops: { to: targetId, renameFrom, mergeFrom, targetExists },
                    master: settings.masterKey,
                })
                item.config.preview = buildConfigPreview(cfg, variants, exact, targetId, renameTarget)
                if (settings.mode === 'conflict') {
                    item.tags.push('settings-conflict')
                    item.notes.push(`Settings conflict on ${settings.conflicts.map(c => c.key).join(', ')}; master ${settings.masterKey} wins and the other value(s) stay visible in the preview.`)
                }
            } else if (!exact) {
                item.config.status = 'none'
            }
        }

        
        if (cfg?.enable) {
            const entries = cfg.enable.items.filter(i => i.value === folder || i.value.toLowerCase() === folder.toLowerCase())
            item.enable.entries = entries.map(i => i.value)
            item.enable.entry = entries[0]?.value || null
            item.wasEnabled = entries.some(i => i.value === folder)
            if (!entries.length) item.enable.status = 'missing'
            else if (entries.length > 1) { item.enable.status = 'duplicate'; item.tags.push('enable-duplicate') }
            else if (entries[0].value !== folder) { item.enable.status = 'variant'; item.tags.push('enable-variant') }
            else item.enable.status = 'exact'
            if (!entries.length) item.notes.push('Not in enable_plugins (currently disabled; choose Ignore to keep it disabled)')
            else if (!item.wasEnabled) item.notes.push('enable_plugins entry has wrong case; HFS matches exactly, so the plugin is not actually enabled. The fix takes effect on the next start.')

            const to = item.target.id || folder
            const needsRename = entries.some(i => i.value !== to)
            if (entries.length && (needsRename || entries.length > 1)) {
                item.fixes.push({
                    type: 'enable',
                    auto: true,
                    label: 'Fix enable_plugins entry',
                    before: item.enable.entries.join(', '),
                    after: to,
                    detail: `Change enable_plugins entry ${item.enable.entries.join(', ')} to ${to}`,
                    entries: item.enable.entries.slice(),
                })
            }
        }

        
        item.severity = computeSeverity(item)
        if (item.tags.includes('not-published')) item.severity = 'healthy'
        return item
    }

    function computeSeverity(item) {
        if (item.tags.includes('no-plugin-js') || item.tags.includes('broken-plugin-js') || item.tags.includes('target-conflict')) return 'unhealthy'
        if (item.tags.includes('online-ambiguous')) return 'suspect'
        if (item.tags.includes('settings-conflict')) return 'suspect'
        if (item.fixes.some(f => f.type === 'config')) return 'need-fix'
        if (item.tags.includes('repo-name-mismatch')) return 'need-fix'
        if (item.fixes.some(f => f.type === 'rename' && !f.optional)) return 'need-fix'
        if (item.fixes.some(f => f.type === 'enable')) return 'need-fix'
        if (item.fixes.some(f => f.type === 'update' && !f.optional && !f.force)) return 'need-fix'
        
        
        if (item.tags.includes('repo-owner-alias')) return 'attention'
        if (item.tags.includes('local-older')
            || item.tags.includes('folder-case-mismatch') || item.tags.includes('folder-name-differs')
            || item.tags.includes('repo-case-mismatch') || item.tags.includes('no-repo')) return 'attention'
        return 'healthy'
    }

    function buildConfigPreview(cfg, variants, exact, to) {
        const lines = cfg.text.split(/\r?\n/)
        const blockOf = sec => {
            const out = []
            for (let i = sec.startLine; i < sec.endLine; i++) out.push(lines[i])
            while (out.length && !out[out.length - 1].trim()) out.pop()
            return out
        }
        const before = []
        if (exact) before.push(...blockOf(exact))
        for (const v of variants) before.push(...blockOf(v))
        const base = variants.find(v => v.key === to) || exact || variants[0]
        const after = []
        if (base) {
            const baseLines = blockOf(base).slice()
            if (to !== base.key && baseLines.length) {
                baseLines[0] = baseLines[0].replace(/^(\s*)("[^"]+"|'[^']+'|[^:]+)(\s*:.*)$/, (m, ind, key, rest) => ind + quoteKey(to) + rest)
            }
            after.push(...baseLines)
            const keys = new Set((base.entries || []).map(e => e.key))
            for (const v of variants) {
                if (v === base) continue
                for (const e of v.entries || []) {
                    if (keys.has(e.key)) continue
                    after.push(...lines.slice(e.line, Math.min(e.endLine, v.endLine)))
                    keys.add(e.key)
                }
            }
        }
        return { before: before.join('\n'), after: after.join('\n') }
    }

    function expandConfigOps(fix) {
        const ops = []
        const { to, renameFrom, mergeFrom, targetExists } = fix?.ops || {}
        if (!to) return ops
        if (renameFrom && renameFrom !== to) ops.push({ type: 'renameSection', from: renameFrom, to })
        const rest = (mergeFrom || []).filter(k => k !== to && k !== renameFrom)
        if (!renameFrom && !targetExists && rest.length) {
            const first = rest.shift()
            ops.push({ type: 'renameSection', from: first, to })
        }
        for (const from of rest) ops.push({ type: 'mergeSections', from, to })
        return ops
    }

    
    
    
    function cmpVersionInfo(a, b) {
        const A = numericVersion(a), B = numericVersion(b)
        if (A && B) return compareVersion(a, b)
        if (A && !B) return 1
        if (!A && B) return -1
        return 0
    }

    function sectionValues(text, sec) {
        const lines = text.split(/\r?\n/)
        const out = new Map()
        for (const e of sec.entries || []) {
            const end = Math.min(e.endLine, sec.endLine)
            const block = lines.slice(e.line, end).map(l => l.replace(/\s+$/, '')).join('\n').trim()
            out.set(e.key, block)
        }
        return out
    }

    function folderForSectionKey(key, ctx) {
        if (!ctx?.folders) return null
        let folder = ctx.folders.find(f => f === key)
        if (!folder) folder = ctx.folders.find(f => f.toLowerCase() === String(key).toLowerCase())
        if (!folder) {
            const n = normalizeName(key)
            const matches = ctx.folders.filter(f => normalizeName(f) === n)
            if (matches.length === 1) folder = matches[0]
        }
        if (!folder) return null
        const meta = ctx.folderMeta.get(folder) || {}
        return { folder, version: meta.version ?? null, mtime: meta.mtime || null }
    }

    function pickSettingsMaster(exact, variants, targetSec, ctx) {
        if (targetSec && (!exact || targetSec.key !== exact.key))
            return { sec: targetSec, role: 'target', info: folderForSectionKey(targetSec.key, ctx) }
        if (exact) return { sec: exact, role: 'live', info: folderForSectionKey(exact.key, ctx) }
        let best = null
        for (const v of variants) {
            const info = folderForSectionKey(v.key, ctx)
            const entries = v.entries?.length || 0
            const cand = { sec: v, role: 'variant', info, entries }
            if (!best) { best = cand; continue }
            const c = cmpVersionInfo(info?.version, best.info?.version)
            let better = c > 0
            if (c === 0) {
                const am = info?.mtime || 0
                const bm = best.info?.mtime || 0
                if (am !== bm) better = am > bm
                else if (entries !== best.entries) better = entries > best.entries
            }
            if (better) best = cand
        }
        return best
    }

    function settingsMasterReason(master, folder, conflicts, ctx) {
        const info = master.info
        const bits = []
        if (info?.folder) bits.push(info.folder)
        if (info?.version != null && info.version !== '') bits.push('v' + info.version)
        if (info?.mtime) bits.push('modified ' + fmtStamp(info.mtime))
        bits.push(master.role === 'live' ? 'live plugin settings'
            : master.role === 'target' ? 'existing target settings'
                : 'newest/highest-version settings section')
        return bits.join(' · ')
    }

    function analyzeSettings(cfg, folder, exact, variants, targetId, ctx) {
        const targetSec = cfg.sections.find(s => s.key === targetId)
        const sections = [...new Set([exact, ...variants].filter(Boolean))]
        if (!sections.length) {
            return { mode: 'none', masterKey: null, keys: 0, added: 0, identical: 0, conflicts: [], variants: [] }
        }
        const master = pickSettingsMaster(exact, variants, targetSec, ctx)
        const masterSec = master.sec
        const masterValues = sectionValues(cfg.text, masterSec)
        const conflicts = []
        let added = 0
        let identical = 0
        for (const sec of sections) {
            if (sec === masterSec) continue
            const vals = sectionValues(cfg.text, sec)
            for (const [key, value] of vals) {
                if (!masterValues.has(key)) { added++; continue }
                if (masterValues.get(key) === value) { identical++; continue }
                const info = folderForSectionKey(sec.key, ctx)
                conflicts.push({
                    key,
                    masterValue: masterValues.get(key).slice(0, 180),
                    otherKey: sec.key,
                    otherValue: value.slice(0, 180),
                    otherFolder: info?.folder || null,
                    otherVersion: info?.version ?? null,
                    otherMtime: info?.mtime || null,
                })
            }
        }
        const mode = conflicts.length ? 'conflict'
            : sections.length === 1 ? 'single'
                : added ? 'mergeable' : 'identical'
        return {
            mode,
            masterKey: masterSec.key,
            masterRole: master.role,
            masterFolder: master.info?.folder || null,
            masterVersion: master.info?.version ?? null,
            masterMtime: master.info?.mtime || null,
            masterReason: settingsMasterReason(master, folder, conflicts, ctx),
            keys: masterValues.size,
            added,
            identical,
            conflicts,
            variants: sections.filter(s => s !== masterSec).map(sec => {
                const info = folderForSectionKey(sec.key, ctx)
                return {
                    key: sec.key,
                    folder: info?.folder || null,
                    version: info?.version ?? null,
                    mtime: info?.mtime || null,
                    entries: sec.entries?.length || 0,
                }
            }),
        }
    }

    function pickDuplicateMaster(items, target) {
        let best = items[0]
        for (const it of items.slice(1)) {
            const c = cmpVersionInfo(it.version, best.version)
            let better = c > 0
            if (c === 0) {
                const ar = normalizeName(splitRepo(it.repo).name) === normalizeName(target)
                const br = normalizeName(splitRepo(best.repo).name) === normalizeName(target)
                if (ar !== br) better = ar
                else {
                    const am = it.mtime || 0
                    const bm = best.mtime || 0
                    if (am !== bm) better = am > bm
                    else better = String(it.folder).toLowerCase() === String(target).toLowerCase()
                }
            }
            if (better) best = it
        }
        return best
    }

    function duplicateMasterReason(master, items, target) {
        const bits = []
        if (master.version != null && items.some(i => i !== master && cmpVersionInfo(master.version, i.version) > 0))
            bits.push('highest version v' + master.version)
        if (master.mtime && items.some(i => i !== master && (i.mtime || 0) < master.mtime))
            bits.push('newest plugin.js (' + fmtStamp(master.mtime) + ')')
        if (master.repo && normalizeName(splitRepo(master.repo).name) === normalizeName(target))
            bits.push('repository matches install name')
        if (!bits.length) bits.push('closest to the install name')
        return bits.join(' · ')
    }

    function analyzeDuplicateSettings(dup, master, ctx) {
        const cfg = ctx.config
        if (!cfg) return { masterKey: master.folder, masterHasSection: false, fromKeys: [], added: 0, identical: 0, conflicts: [] }
        const masterKey = master.config?.key || master.config?.targetKey || master.folder
        const masterSec = cfg.sections.find(s => s.key === masterKey)
        const fromKeys = [...new Set([
            dup.config?.key,
            ...(dup.config?.variants || []),
        ].filter(Boolean))].filter(k => k !== masterKey)
        const masterValues = masterSec ? sectionValues(cfg.text, masterSec) : new Map()
        const conflicts = []
        let added = 0
        let identical = 0
        for (const key of fromKeys) {
            const sec = cfg.sections.find(s => s.key === key)
            if (!sec) continue
            const vals = sectionValues(cfg.text, sec)
            for (const [k, value] of vals) {
                if (!masterValues.has(k)) { added++; continue }
                if (masterValues.get(k) === value) { identical++; continue }
                conflicts.push({
                    key: k,
                    masterValue: masterValues.get(k).slice(0, 180),
                    otherKey: key,
                    otherValue: value.slice(0, 180),
                })
            }
        }
        return { masterKey, masterHasSection: !!masterSec, fromKeys, keys: masterValues.size, added, identical, conflicts }
    }

    async function buildReport({ deep = false, runningIds = [] } = {}) {
        const started = Date.now()
        const cfgModel = readConfigModel()
        if (!cfgModel) throw Error(`Cannot find ${CONFIG_NAME} (${CONFIG_PATH})`)
        const cfg = cfgModel.doc.plugins ? {
            text: cfgModel.text,
            sections: cfgModel.doc.plugins.sections,
            enable: cfgModel.doc.enable,
        } : null
        if (!cfg) throw Error(`${CONFIG_NAME} has no plugins_config block`)

        const allFolders = listDirs(PLUGINS_ROOT)
        const ignoreSet = ignoredFolderSet()
        const pluginIgnore = ignoredPluginSet()
        const isIgnoredFolder = f =>
            ignoreSet.has(f.toLowerCase()) || pluginIgnore.has(f.toLowerCase()) || NATIVE_PLUGINS.has(f.toLowerCase())
        const folders = allFolders.filter(f => !/-disabled$/i.test(f) && !isIgnoredFolder(f))
        const ignoredFolderNames = [...new Set([
            ...allFolders.filter(isIgnoredFolder),
            ...pluginIgnore,
        ])]
        const ignoredLower = new Set([
            ...ignoredFolderNames.map(f => f.toLowerCase()),
            ...NATIVE_PLUGINS,
        ])
        const ignoredNorm = new Set([
            ...ignoredFolderNames.map(f => normalizeName(f)),
            ...NATIVE_PLUGINS,
        ])
        const folderMeta = new Map()
        for (const folder of folders) {
            const meta = { version: null, mtime: null }
            try {
                const file = path.join(PLUGINS_ROOT, folder, 'plugin.js')
                meta.mtime = fs.statSync(file).mtimeMs
                meta.version = parsePluginMeta(readText(file)).version
            } catch {}
            folderMeta.set(folder, meta)
        }
        const decisions = loadDecisions()
        const online = await loadOnlineCatalog()
        const index = onlineIndex(online.entries)
        const onlineByRepo = new Map(online.entries.map(e => [String(e.repo || e.id).toLowerCase(), e]))
        const ctx = {
            config: cfg,
            folders,
            folderMeta,
            decisions,
            running: new Set(runningIds.map(String)),
            onlineByRepo,
            index,
        }
        const items = []
        for (const folder of folders) {
            try { items.push(makeItem(folder, ctx)) } catch (e) {
                items.push({ id: folder, folder, dir: path.join(PLUGINS_ROOT, folder), hasPluginJs: false, broken: true, error: e.message, tags: ['broken-plugin-js'], severity: 'unhealthy', fixes: [], notes: [e.message], decision: 'fix', config: { status: 'none', variants: [] }, enable: { status: 'none', entries: [] }, target: { id: folder, source: 'none' }, online: null, repo: '' })
            }
        }

        
        const byTarget = new Map()
        for (const it of items) {
            if (it.target.source === 'none' || it.target.id === it.folder) continue
            const key = it.target.id.toLowerCase()
            const list = byTarget.get(key) || []
            list.push(it)
            byTarget.set(key, list)
        }
        for (const [target, list] of byTarget) {
            const existing = items.find(i => i.folder.toLowerCase() === target && !list.includes(i))
            const group = existing ? [...list, existing] : [...list]
            if (group.length < 2) continue
            const master = pickDuplicateMaster(group, target)
            const reason = duplicateMasterReason(master, group, target)
            for (const it of group) {
                it.duplicateMaster = {
                    folder: master.folder,
                    version: master.version ?? null,
                    mtime: master.mtime || null,
                    reason,
                    isMaster: it === master,
                }
                const masterLabel = `${master.folder} (v${master.version ?? '—'}${master.mtime ? ' · ' + fmtStamp(master.mtime) : ''})`
                if (it === master) {
                    it.tags.push('duplicate-master')
                    it.notes.push(`Master copy: ${masterLabel} — ${reason}. Keep this folder; duplicates merge into it.`)
                    if (it.severity === 'healthy') it.severity = 'attention'
                    if (existing && it !== existing) {
                        it.fixes = it.fixes.filter(f => f.type === 'repo')
                        it.notes.push(`Merge or remove the duplicate folder ${existing.folder} first, then scan again to rename this one to ${target}.`)
                        if (!it.fixes.length && it.severity === 'need-fix') it.severity = 'attention'
                    }
                } else {
                    const merge = analyzeDuplicateSettings(it, master, ctx)
                    it.mergeDuplicate = {
                        ...merge,
                        masterFolder: master.folder,
                        masterVersion: master.version ?? null,
                        masterMtime: master.mtime || null,
                        masterLabel,
                    }
                    it.tags.push('duplicate-install')
                    const mergeFix = {
                        type: 'duplicate-merge',
                        label: 'Merge settings into master and remove duplicate',
                        before: it.folder,
                        after: master.folder,
                        detail: merge.fromKeys.length
                            ? `Merge ${merge.fromKeys.join(', ')} into ${merge.masterKey}: ${merge.added} key(s) added, ${merge.conflicts.length} conflict(s) (master wins). The duplicate folder then moves to trash.`
                            : `No config settings to migrate; the duplicate folder then moves to trash.`,
                        masterFolder: master.folder,
                        masterKey: merge.masterKey,
                        fromKeys: merge.fromKeys,
                        masterHasSection: merge.masterHasSection,
                    }
                    it.fixes = [mergeFix]
                    it.severity = 'unhealthy'
                    it.notes.push(`Merge recommended: duplicate of master ${masterLabel}. ${merge.added} setting key(s) will be added${merge.conflicts.length ? `, ${merge.conflicts.length} conflict(s) keep the master value` : ''}.`)
                }
            }
        }

        
        const consumed = new Set()
        for (const it of items) {
            if (it.config.key) consumed.add(it.config.key)
            for (const v of it.config.variants) consumed.add(v)
        }
        const configOrphans = cfg.sections
            .filter(s => !consumed.has(s.key)
                && !ignoredLower.has(s.key.toLowerCase())
                && !ignoredNorm.has(normalizeName(s.key)))
            .map(s => ({
                id: 'cfg:' + s.key,
                kind: 'config-orphan',
                key: s.key,
                value: s.value,
                entries: s.entries.length,
                severity: 'attention',
                tag: 'config-orphan',
                tags: ['config-orphan'],
                notes: ['Config section with no matching plugin folder in config.yaml'],
                decision: ctx.decisions['cfg:' + s.key] || 'fix',
                fixes: [{ type: 'config-remove', label: 'Remove orphan config section', before: s.key, after: '(removed)', detail: `plugins_config.${s.key} has no matching plugin folder`, auto: false }],
            }))
        const enableOrphans = (cfg.enable?.items || [])
            .filter(i => !items.some(it => it.folder.toLowerCase() === i.value.toLowerCase())
                && !ignoredLower.has(i.value.toLowerCase())
                && !ignoredNorm.has(normalizeName(i.value)))
            .map(i => ({
                id: 'en:' + i.value,
                kind: 'enable-orphan',
                key: i.value,
                severity: 'attention',
                tag: 'enable-orphan',
                tags: ['enable-orphan'],
                notes: ['Enable entry with no matching plugin folder'],
                decision: ctx.decisions['en:' + i.value] || 'fix',
                fixes: [{ type: 'enable-remove', label: 'Remove enable entry', before: i.value, after: '(removed)', detail: `enable_plugins entry ${i.value} has no folder`, auto: false }],
            }))

        
        
        const sectionOwner = new Map()
        for (const it of items) {
            if (it.config?.key) sectionOwner.set(it.config.key, it)
            for (const v of it.config?.variants || []) if (!sectionOwner.has(v)) sectionOwner.set(v, it)
        }
        const configKeyOrphans = []
        for (const s of cfg.sections) {
            if (configOrphans.some(o => o.key === s.key)) continue
            if (ignoredLower.has(s.key.toLowerCase()) || ignoredNorm.has(normalizeName(s.key))) continue
            const owner = sectionOwner.get(s.key)
            if (!owner) continue
            const valid = pluginDeclaredKeys(owner.folder)
            if (!valid) continue
            for (const e of s.entries) {
                if (valid.has(e.key)) continue
                const id = 'cfgkey:' + encodeURIComponent(s.key) + '|' + encodeURIComponent(e.key)
                configKeyOrphans.push({
                    id,
                    kind: 'config-key-orphan',
                    key: s.key + '.' + e.key,
                    section: s.key,
                    entryKey: e.key,
                    severity: 'attention',
                    tag: 'orphan-setting',
                    tags: ['orphan-setting'],
                    notes: [`Setting "${e.key}" is not declared in ${owner.folder}/plugin.js exports.config`],
                    decision: ctx.decisions[id] || 'fix',
                    fixes: [{ type: 'config-key-remove', label: 'Remove obsolete setting', before: e.key, after: '(removed)', detail: `plugins_config.${s.key}.${e.key} is no longer declared by the plugin`, auto: false }],
                })
            }
        }

        const stats = { total: items.length, healthy: 0, needFix: 0, unhealthy: 0, attention: 0, suspect: 0, fixes: 0 }
        for (const it of items) {
            if (it.severity === 'healthy') stats.healthy++
            else if (it.severity === 'need-fix') stats.needFix++
            else if (it.severity === 'unhealthy') stats.unhealthy++
            else if (it.severity === 'suspect') stats.suspect++
            else stats.attention++
            if (it.fixes.length) stats.fixes++
        }
        return {
            startedAt: started,
            finishedAt: Date.now(),
            paths: { plugins: PLUGINS_ROOT, config: CONFIG_PATH, storage: storageDir, mirror: exists(MIRROR_FILE) ? MIRROR_FILE : null },
            online: { source: online.source, updatedAt: online.updatedAt, count: online.entries.length, error: online.error || null, deep },
            deep: !!deep,
            stats,
            sectionCount: cfg.sections.length,
            enableCount: cfg.enable?.items?.length || 0,
            items: items.sort(sortItems),
            orphans: { config: configOrphans, enable: enableOrphans, keys: configKeyOrphans },
            ignoredFolders: ignoredFolderNames,
            ignored: Object.entries(decisions).filter(([, v]) => v === 'ignore').length,
        }
    }

    function sortItems(a, b) {
        const rank = { unhealthy: 0, 'need-fix': 1, suspect: 2, attention: 3, healthy: 4 }
        const d = (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9)
        if (d) return d
        return String(a.folder).localeCompare(String(b.folder))
    }

    
    
    
    let decisionsCache = null
    function loadDecisions() {
        if (decisionsCache) return decisionsCache
        const d = readJsonFile(DECISIONS_FILE, {})
        decisionsCache = d && typeof d === 'object' ? d : {}
        return decisionsCache
    }
    function saveDecisions(patch) {
        const d = { ...loadDecisions(), ...patch }
        for (const [k, v] of Object.entries(d)) if (!v || v === 'fix') delete d[k]
        decisionsCache = d
        writeJsonFile(DECISIONS_FILE, d)
        return d
    }

    
    
    
    function safeResolvePluginDir(id) {
        const dir = path.join(PLUGINS_ROOT, id)
        if (path.dirname(dir) !== path.resolve(PLUGINS_ROOT)) return null
        return isDir(dir) ? dir : null
    }

    function backupPluginJs(item) {
        const stamp = timestamp()
        const dir = path.join(BACKUP_IN_SELF, stamp)
        ensureDir(dir)
        const src = path.join(PLUGINS_ROOT, item.folder, 'plugin.js')
        const dst = path.join(dir, item.folder + '.plugin.js')
        fs.copyFileSync(src, dst)
        return dst
    }

    function rewriteRepo(item, newRepo) {
        const file = path.join(PLUGINS_ROOT, item.folder, 'plugin.js')
        const src = readText(file)
        const re = /(exports\.repo\s*=\s*)(['"])([^'"]*)(\2)/
        const m = src.match(re)
        if (!m) return { ok: false, error: 'exports.repo not found' }
        if (m[3] === newRepo) return { ok: false, error: 'unchanged' }
        const bak = backupPluginJs(item)
        const out = src.replace(re, (all, pre, q1, old, q2) => pre + q1 + newRepo + q2)
        const tmp = file + '.repair-tmp'
        fs.writeFileSync(tmp, out, 'utf8')
        try { fs.renameSync(tmp, file) } catch {
            try { fs.unlinkSync(tmp) } catch {}
            fs.writeFileSync(file, out, 'utf8')
        }
        return { ok: true, backup: bak, before: m[3], after: newRepo }
    }

    async function applyPluginUpdate(item, fix) {
        const fromVersion = fix.from ?? fix.before
        let body = null
        let usedUrl = null
        for (const url of fix.urls || []) {
            const cached = fix.reinstall ? null : readOptimizerCache(url, 'GET', 24 * 3600 * 1000)
            const r = cached || await httpsText(url, { timeout: 20000 })
            if (r.status === 200 && r.body && /exports\.version/.test(r.body)) {
                body = r.body
                usedUrl = url
                break
            }
        }
        if (!body) return { ok: false, error: 'could not download an online plugin.js' }
        const meta = parsePluginMeta(body)
        if (!fix.reinstall) {
            if (fix.force) {
                if (String(meta.version) === String(fromVersion))
                    return { ok: false, error: `online version equals local v${fromVersion}` }
            } else if (compareVersion(meta.version, fromVersion) !== 1) {
                return { ok: false, error: `online v${meta.version ?? '?'} is not newer than local v${fromVersion}` }
            }
        }
        const bak = backupPluginJs(item)
        const file = path.join(PLUGINS_ROOT, item.folder, 'plugin.js')
        const tmp = file + '.repair-tmp'
        fs.writeFileSync(tmp, body, 'utf8')
        try { fs.renameSync(tmp, file) } catch {
            try { fs.unlinkSync(tmp) } catch {}
            fs.writeFileSync(file, body, 'utf8')
        }
        return { ok: true, backup: bak, from: fromVersion, to: meta.version, url: usedUrl }
    }

    function renameFolder(item, newId) {
        const from = path.join(PLUGINS_ROOT, item.folder)
        const to = path.join(PLUGINS_ROOT, newId)
        if (exists(to)) {
            if (item.folder.toLowerCase() === newId.toLowerCase()) {
                const tmp = path.join(PLUGINS_ROOT, newId + '.repair-case-' + Date.now())
                fs.renameSync(from, tmp)
                try { fs.renameSync(tmp, to) } catch (e) { try { fs.renameSync(tmp, from) } catch {} ; throw e }
                return { ok: true, caseOnly: true }
            }
            throw Error(`Target folder already exists: ${newId}`)
        }
        fs.renameSync(from, to)
        return { ok: true }
    }

    function moveToTrash(item) {
        ensureDir(TRASH_DIR)
        const stamp = timestamp()
        const dir = path.join(TRASH_DIR, stamp)
        ensureDir(dir)
        const from = path.join(PLUGINS_ROOT, item.folder)
        const to = path.join(dir, item.folder)
        try {
            fs.renameSync(from, to)
        } catch (e) {
            
            fs.cpSync(from, to, { recursive: true })
            fs.rmSync(from, { recursive: true, force: true })
        }
        writeJsonFile(path.join(dir, item.folder + '.trash.json'), {
            id: item.folder,
            repo: item.repo,
            version: item.version,
            deletedAt: Date.now(),
            config: item.config.preview?.before || '',
        })
        return to
    }

    async function hfsCall(name, ...args) {
        try {
            const fn = hfsPlugins && hfsPlugins[name]
            if (typeof fn !== 'function') return { ok: false, error: 'unavailable' }
            const value = await fn(...args)
            return { ok: true, value }
        } catch (e) {
            return { ok: false, error: e.message || String(e) }
        }
    }
    const sleep = ms => new Promise(r => setTimeout(r, ms))

    async function runApply(job, body) {
        const actions = Array.isArray(body.actions) ? body.actions : []
        const allowRename = true 
        const repoOnly = !!body.repoOnly
        const ownerOnly = !!body.ownerOnly
        const runningIds = new Set((body.runningIds || []).map(String))
        jobLog(job, 'info', `Apply: ${actions.length} item(s) (${repoOnly ? 'repo only' : 'folder renames ' + (allowRename ? 'allowed' : 'disabled')})`)
        jobLog(job, 'dim', hfsPluginsAvailable
            ? 'HFS plugin manager available: stop, rename, migrate settings, reload and start automatically'
            : 'HFS plugin manager unavailable: files only; restart HFS for full effect')

        const report = await buildReport({ deep: false, runningIds: [...runningIds] })
        const byId = new Map(report.items.map(i => [i.id, i]))
        const plans = []
        const orphanRemovals = { sections: [], enables: [], keys: [] }
        for (const action of actions) {
            const actionId = String(action.id || '')
            const decision = action.decision || 'fix'
            if (actionId.startsWith('cfgkey:')) {
                if (decision === 'ignore') continue
                const [section, key] = actionId.slice(7).split('|').map(decodeURIComponent)
                if (section && key) orphanRemovals.keys.push({ section, key })
                continue
            }
            if (actionId.startsWith('cfg:') || actionId.startsWith('en:')) {
                if (decision === 'ignore') continue
                if (actionId.startsWith('cfg:')) orphanRemovals.sections.push(actionId.slice(4))
                else orphanRemovals.enables.push(actionId.slice(3))
                continue
            }
            const item = byId.get(action.id)
            if (!item) { jobLog(job, 'warn', `Skip ${action.id}: scan result changed`); continue }
            const dec = action.decision || item.decision || 'fix'
            const forceOnline = !!action.forceOnline
            if (dec === 'ignore') continue
            if (dec === 'delete' && item.folder === PLUGIN_ID) {
                jobLog(job, 'error', `Refusing to delete ${PLUGIN_ID} (this plugin)`)
                continue
            }
            const mergeFix = item.fixes.find(f => f.type === 'duplicate-merge') || null
            if (mergeFix) {
                plans.push({
                    item,
                    decision: 'fix',
                    merge: mergeFix,
                    repoFix: null,
                    updateFix: null,
                    rename: null,
                    cfgFix: null,
                    enableFix: null,
                    wasRunning: runningIds.has(item.folder),
                    wasEnabled: !!item.wasEnabled,
                    repoOnly,
                })
                continue
            }
            const cfgFixAll = item.fixes.find(f => f.type === 'config') || null
            const cfgFix = (!repoOnly && cfgFixAll && (allowRename || cfgFixAll.ops.to === item.folder))
                ? cfgFixAll : null
            const repoFixAll = item.fixes.find(f => f.type === 'repo') || null
            const sameRepoName = repoFixAll
                && splitRepo(repoFixAll.before).name.toLowerCase() === splitRepo(repoFixAll.after).name.toLowerCase()
            const repoFix = repoFixAll && (!ownerOnly || sameRepoName) ? repoFixAll : null
            if (repoOnly && !repoFix) {
                jobLog(job, 'dim', `Skip ${item.folder}: this fix would rename the repository; use the full fix`)
                continue
            }
            plans.push({
                item,
                decision: repoOnly ? 'fix' : dec,
                repoFix,
                updateFix: dec === 'fix' && !repoOnly
                    ? (item.fixes.find(f => f.type === 'update' && (!f.force || forceOnline)) || null) : null,
                rename: !repoOnly && allowRename ? (item.fixes.find(f => f.type === 'rename') || null) : null,
                cfgFix,
                enableFix: !repoOnly ? (item.fixes.find(f => f.type === 'enable') || null) : null,
                wasRunning: runningIds.has(item.folder),
                wasEnabled: !!item.wasEnabled,
                repoOnly,
                merge: null,
            })
        }

        const results = []
        const undo = { renames: [], repos: [], updates: [], trash: [], configBackup: null, createdAt: Date.now() }

        
        for (const p of plans) {
            if (!(p.rename || p.merge || p.updateFix || p.decision === 'delete')) continue
            if (!p.wasRunning) continue
            const r = await hfsCall('stopPlugin', p.item.folder)
            if (r.ok) jobLog(job, 'dim', `Stop ${p.item.folder}`)
            else jobLog(job, 'warn', `Stop ${p.item.folder} failed: ${r.error} (still trying)`)
        }
        if (hfsPluginsAvailable) {
            for (const p of plans) {
                if (p.decision !== 'delete' && !p.merge) continue
                await hfsCall('enablePlugin', p.item.folder, false)
            }
        }

        
        for (const p of plans) {
            if (p.decision === 'delete' || !p.updateFix) continue
            try {
                const r = await applyPluginUpdate(p.item, p.updateFix)
                if (r.ok) {
                    p.updated = true
                    p.updatedFrom = r.from
                    p.updatedTo = r.to
                    undo.updates.push({ id: p.item.folder, backup: r.backup, from: r.from, to: r.to })
                    jobLog(job, 'ok', `Update ${p.item.folder}: v${r.from} → v${r.to}`)
                } else {
                    p.updateError = r.error
                    jobLog(job, 'warn', `Update ${p.item.folder} failed: ${r.error}`)
                }
            } catch (e) {
                p.updateError = e.message
                jobLog(job, 'error', `Update ${p.item.folder} failed: ${e.message}`)
            }
        }

        
        for (const p of plans) {
            if (p.decision === 'delete' || !p.repoFix) continue
            try {
                const r = rewriteRepo(p.item, p.repoFix.after)
                if (r.ok) {
                    undo.repos.push({ id: p.item.folder, backup: r.backup, before: r.before, after: r.after })
                    jobLog(job, 'ok', `repo  ${p.item.folder}: ${r.before} → ${r.after}`)
                } else if (r.error !== 'unchanged') {
                    jobLog(job, 'warn', `repo  ${p.item.folder}: ${r.error}`)
                    p.error = r.error
                }
            } catch (e) {
                jobLog(job, 'error', `Repo ${p.item.folder} failed: ${e.message}`)
                p.error = e.message
            }
        }

        
        for (const p of plans) {
            if (p.decision === 'delete' || !p.rename || p.error) continue
            try {
                renameFolder(p.item, p.rename.after)
                undo.renames.push({ from: p.item.folder, to: p.rename.after, wasEnabled: p.wasEnabled, wasRunning: p.wasRunning })
                p.renamed = true
                p.finalId = p.rename.after
                jobLog(job, 'ok', `Rename ${p.item.folder} → ${p.rename.after}`)
            } catch (e) {
                p.error = e.message
                jobLog(job, 'error', `Rename ${p.item.folder} → ${p.rename.after} failed: ${e.message}`)
                if (p.repoFix) {
                    try {
                        const rec = undo.repos.find(x => x.id === p.item.folder)
                        if (rec) fs.copyFileSync(rec.backup, path.join(PLUGINS_ROOT, p.item.folder, 'plugin.js'))
                    } catch {}
                }
            }
        }

        
        for (const p of plans) {
            if (p.decision !== 'delete' && !p.merge) continue
            try {
                const to = moveToTrash(p.item)
                undo.trash.push({ id: p.item.folder, path: to, wasEnabled: p.wasEnabled, wasRunning: p.wasRunning })
                p.deleted = true
                if (p.merge) {
                    p.merged = true
                    jobLog(job, 'ok', `Merge duplicate ${p.item.folder} into ${p.merge.masterKey} and move it to storage/trash/${path.basename(path.dirname(to))}/`)
                } else {
                    jobLog(job, 'ok', `Delete ${p.item.folder} → storage/trash/${path.basename(path.dirname(to))}/`)
                }
            } catch (e) {
                p.error = e.message
                jobLog(job, 'error', `${p.merge ? 'Merge' : 'Delete'} ${p.item.folder} failed: ${e.message}`)
            }
        }

        
        
        
        if (hfsPluginsAvailable) {
            const r = await hfsCall('rescan')
            if (!r.ok) jobLog(job, 'warn', 'Plugin rescan failed: ' + r.error)
            if (undo.renames.length) await sleep(400)
        }

        
        let cfgModel = readConfigModel()
        const configOps = []
        const merges = []
        const removedSections = []
        const enableRename = {}
        const enableRemove = []
        const mustHave = []
        const mustNotHave = []
        const mustNotHaveKeys = []
        const enableMustHave = []
        const enableMustNotHave = []

        for (const p of plans) {
            if (p.error || p.repoOnly) continue
            if (p.merge) {
                if (!p.deleted) continue
                const m = p.merge
                const fromKeys = (m.fromKeys || []).filter(Boolean)
                if (fromKeys.length) {
                    if (m.masterHasSection) {
                        for (const from of fromKeys) {
                            configOps.push({ type: 'mergeSections', from, to: m.masterKey })
                            merges.push({ from, to: m.masterKey })
                            mustNotHave.push(from)
                        }
                    } else {
                        const [first, ...rest] = fromKeys
                        configOps.push({ type: 'renameSection', from: first, to: m.masterKey })
                        mustNotHave.push(first)
                        for (const from of rest) {
                            configOps.push({ type: 'mergeSections', from, to: m.masterKey })
                            merges.push({ from, to: m.masterKey })
                            mustNotHave.push(from)
                        }
                    }
                    mustHave.push(m.masterKey)
                }
                for (const e of p.item.enable.entries || []) { enableRemove.push(e); enableMustNotHave.push(e) }
                enableRemove.push(p.item.folder)
                enableMustNotHave.push(p.item.folder)
                continue
            }
            if (p.decision === 'delete') {
                if (!p.deleted) continue
                const keys = new Set([p.item.config.key, ...(p.item.config.variants || [])].filter(Boolean))
                
                
                for (const sec of cfgModel.doc.plugins?.sections || []) {
                    if (sec.key.toLowerCase() === p.item.folder.toLowerCase()) keys.add(sec.key)
                }
                if (keys.size) {
                    const list = [...keys]
                    configOps.push({ type: 'removeSections', keys: list })
                    for (const k of list) { removedSections.push(k); mustNotHave.push(k) }
                }
                for (const e of p.item.enable.entries || []) { enableRemove.push(e); enableMustNotHave.push(e) }
                enableRemove.push(p.item.folder)
                enableMustNotHave.push(p.item.folder)
                continue
            }
            const to = p.renamed ? p.rename.after : (p.cfgFix?.ops?.to || p.item.folder)
            if (p.cfgFix) {
                const ops = expandConfigOps(p.cfgFix)
                for (const op of ops) {
                    configOps.push(op)
                    if (op.type === 'mergeSections') merges.push({ from: op.from, to: op.to })
                    mustNotHave.push(op.from)
                }
                mustHave.push(to)
            }
            for (const e of p.item.enable.entries || []) {
                if (e === to) continue
                configOps.push({ type: 'renameEnable', from: e, to })
                enableRename[e] = to
                enableMustNotHave.push(e)
            }
            if (p.item.enable.entries?.length) enableMustHave.push(to)
        }

        for (const key of orphanRemovals.sections) {
            configOps.push({ type: 'removeSections', keys: [key] })
            mustNotHave.push(key)
        }
        for (const v of orphanRemovals.enables) {
            enableRemove.push(v)
            enableMustNotHave.push(v)
        }
        for (const k of orphanRemovals.keys) {
            configOps.push({ type: 'removeConfigKeys', section: k.section, keys: [k.key] })
            mustNotHaveKeys.push(k)
        }

        if (configOps.length || enableRemove.length) {
            let plannedText = null
            try {
                const planned = planConfigOps(cfgModel.doc, [...configOps, { type: 'removeEnable', values: enableRemove }])
                plannedText = planned.text
                const problem = validateConfig(planned.text, {
                    mustHave, mustNotHave, mustNotHaveKeys, enableMustHave, enableMustNotHave,
                })
                if (problem) throw Error('Config validation failed: ' + problem)
                const bak = writeConfigText(planned.text)
                undo.configBackup = bak
                jobLog(job, 'ok', `config.yaml backed up and written (${path.basename(bak)})`)
                for (const m of merges) jobLog(job, 'dim', `Merge settings ${m.from} → ${m.to}`)
                syncLiveConfig({ merges, renames: undo.renames, removed: [...removedSections, ...orphanRemovals.sections], removedKeys: orphanRemovals.keys, enableRename, enableRemove })
            } catch (e) {
                try {
                    fs.writeFileSync(path.join(storageDir, 'last-planned.yaml'), plannedText || '', 'utf8')
                    fs.writeFileSync(path.join(storageDir, 'last-ops.json'), JSON.stringify({ configOps, enableRemove, mustHave, mustNotHave, enableMustHave, enableMustNotHave }, null, 2), 'utf8')
                } catch {}
                jobLog(job, 'error', 'Failed to write config.yaml: ' + e.message)
                jobLog(job, 'dim', 'Planned text/ops saved to storage/last-planned.yaml and storage/last-ops.json')
                rollback(undo)
                writeJsonFile(LAST_BATCH_FILE, { ...undo, failed: true, error: e.message, finishedAt: Date.now() })
                job.result = { ok: false, error: e.message, results }
                return
            }
        }

        
        

        
        if ((undo.configBackup || undo.renames.length) && hfsPluginsAvailable) await sleep(900)
        for (const p of plans) {
            if (!p.renamed || !hfsPluginsAvailable) continue
            if (p.wasEnabled) {
                const e = await hfsCall('enablePlugin', p.finalId, true)
                if (e.ok) jobLog(job, 'dim', `Enable ${p.finalId}`)
                else jobLog(job, 'dim', `Enable ${p.finalId} deferred to HFS rescan (${e.error})`)
            } else {
                jobLog(job, 'dim', `${p.finalId} was disabled; keeping it disabled`)
            }
            if (!p.wasRunning) continue
            const s = await hfsCall('startPlugin', p.finalId)
            if (s.ok) jobLog(job, 'ok', `Start ${p.finalId}`)
            else jobLog(job, 'warn', `Start ${p.finalId} failed (${s.error}); it will start after an HFS restart`)
        }
        if (hfsPluginsAvailable) {
            for (const p of plans) {
                if (!p.updateFix || p.renamed || !p.wasRunning) continue
                const s = await hfsCall('startPlugin', p.item.folder)
                if (s.ok) jobLog(job, 'ok', `${p.updated ? 'Restart' : 'Restart (update failed)'} ${p.item.folder}`)
                else jobLog(job, 'warn', `Restart ${p.item.folder} failed (${s.error}); restart HFS to reload`)
            }
        }

        
        for (const p of plans) {
            results.push({
                id: p.item.folder,
                decision: p.decision,
                renamedTo: p.renamed ? p.rename.after : null,
                mergedInto: p.merged ? p.merge.masterKey : null,
                deleted: !!p.deleted,
                repo: p.repoFix ? { from: p.repoFix.before, to: p.repoFix.after } : null,
                update: p.updated ? { from: p.updatedFrom, to: p.updatedTo } : null,
                updateError: p.updateError || null,
                error: p.error || null,
            })
        }
        for (const key of orphanRemovals.sections) {
            results.push({ id: 'cfg:' + key, decision: 'fix', removedSection: true })
            jobLog(job, 'ok', `Remove orphan config ${key}`)
        }
        for (const v of orphanRemovals.enables) {
            results.push({ id: 'en:' + v, decision: 'fix', removedEnable: true })
            jobLog(job, 'ok', `Remove orphan enable entry ${v}`)
        }
        for (const k of orphanRemovals.keys) {
            results.push({ id: 'cfgkey:' + k.section + '.' + k.key, decision: 'fix', removedSetting: true })
            jobLog(job, 'ok', `Remove obsolete setting ${k.section}.${k.key}`)
        }
        writeJsonFile(LAST_BATCH_FILE, { ...undo, results, finishedAt: Date.now() })
        appendJournal({ at: Date.now(), actions: results, configBackup: undo.configBackup, renames: undo.renames, updates: undo.updates, trash: undo.trash })
        const restartRequired = !hfsPluginsAvailable && (undo.renames.length > 0 || undo.trash.length > 0 || undo.updates.length > 0)
        const mergedCount = plans.filter(p => p.merged).length
        const deletedCount = undo.trash.length - mergedCount
        job.result = {
            ok: true,
            results,
            backup: undo.configBackup,
            renamed: undo.renames.length,
            updated: undo.updates.length,
            merged: mergedCount,
            deleted: deletedCount,
            restartRequired,
        }
        jobLog(job, 'stat', `Done: ${undo.renames.length} renamed, ${undo.updates.length} updated, ${mergedCount} merged, ${deletedCount} deleted, ${undo.repos.length} repo fixes, config backup ${undo.configBackup ? path.basename(undo.configBackup) : 'none'}`)
        if (restartRequired) jobLog(job, 'warn', 'Restart HFS for folder renames/deletions to take full effect')
        else if (undo.renames.length) jobLog(job, 'ok', 'Renames and settings migration applied live by HFS')
    }

    function rollback(undo) {
        
        for (const r of [...(undo.renames || [])].reverse()) {
            try { fs.renameSync(path.join(PLUGINS_ROOT, r.to), path.join(PLUGINS_ROOT, r.from)) } catch {}
        }
        for (const r of undo.repos || []) {
            try { fs.copyFileSync(r.backup, path.join(PLUGINS_ROOT, r.id, 'plugin.js')) } catch {}
        }
        for (const u of undo.updates || []) {
            try { fs.copyFileSync(u.backup, path.join(PLUGINS_ROOT, u.id, 'plugin.js')) } catch {}
        }
        for (const t of undo.trash || []) {
            try { fs.renameSync(t.path, path.join(PLUGINS_ROOT, t.id)) } catch {}
        }
    }

    async function runUndo(job) {
        const last = readJsonFile(LAST_BATCH_FILE, null)
        if (!last) { jobLog(job, 'warn', 'No batch to undo'); job.result = { ok: false, error: 'nothing to undo' }; return }
        jobLog(job, 'info', 'Undo last batch ...')
        
        if (hfsPluginsAvailable) {
            for (const r of last.renames || []) {
                await hfsCall('stopPlugin', r.to)
                await hfsCall('enablePlugin', r.to, false)
            }
        }
        
        for (const r of last.repos || []) {
            try {
                fs.copyFileSync(r.backup, path.join(PLUGINS_ROOT, r.id, 'plugin.js'))
                jobLog(job, 'ok', `Restore plugin.js: ${r.id}`)
            } catch (e) { jobLog(job, 'warn', `Restore plugin.js ${r.id} failed: ${e.message}`) }
        }
        
        for (const r of [...(last.renames || [])].reverse()) {
            try {
                fs.renameSync(path.join(PLUGINS_ROOT, r.to), path.join(PLUGINS_ROOT, r.from))
                jobLog(job, 'ok', `Restore folder: ${r.to} → ${r.from}`)
            } catch (e) { jobLog(job, 'error', `Restore folder ${r.to} failed: ${e.message}`) }
        }
        
        for (const u of last.updates || []) {
            try {
                fs.copyFileSync(u.backup, path.join(PLUGINS_ROOT, u.id, 'plugin.js'))
                jobLog(job, 'ok', `Restore plugin.js v${u.from}: ${u.id}`)
            } catch (e) { jobLog(job, 'warn', `Restore updated plugin.js ${u.id} failed: ${e.message}`) }
        }
        
        for (const t of [...(last.trash || [])].reverse()) {
            try {
                fs.renameSync(t.path, path.join(PLUGINS_ROOT, t.id))
                jobLog(job, 'ok', `Restore deletion: ${t.id}`)
            } catch (e) { jobLog(job, 'error', `Restore deletion ${t.id} failed: ${e.message}`) }
        }
        
        if (last.configBackup && exists(last.configBackup)) {
            try {
                const bakText = readText(last.configBackup)
                writeConfigText(bakText)
                jobLog(job, 'ok', `Restore config.yaml (${path.basename(last.configBackup)})`)
            } catch (e) { jobLog(job, 'error', 'Restore config.yaml failed: ' + e.message) }
        }
        
        if (hfsPluginsAvailable) {
            await sleep(300)
            await hfsCall('rescan')
            await sleep(500)
            for (const r of last.renames || []) {
                if (!r.wasEnabled) continue
                await hfsCall('enablePlugin', r.from, true)
                if (r.wasRunning) await hfsCall('startPlugin', r.from)
            }
            for (const t of last.trash || []) {
                if (!t.wasEnabled) continue
                await hfsCall('enablePlugin', t.id, true)
                if (t.wasRunning) await hfsCall('startPlugin', t.id)
            }
        }
        fs.renameSync(LAST_BATCH_FILE, LAST_BATCH_FILE + '.undone-' + timestamp())
        job.result = { ok: true, undone: true }
    }

    
    
    
    const jobs = new Map()
    function createJob(kind) {
        const id = 'j' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex')
        const job = { id, kind, status: 'running', lines: [], startedAt: Date.now(), finishedAt: null, result: null, error: null, cancelRequested: false, controller: new AbortController() }
        job.signal = job.controller.signal
        jobs.set(id, job)
        for (const [k, v] of jobs) if (jobs.size > 12 && Date.now() - v.startedAt > 3600_000) jobs.delete(k)
        return job
    }
    function jobLog(job, level, text) {
        if (!job) return
        job.lines.push({ t: Date.now(), level, text: String(text) })
        if (job.lines.length > 4000) job.lines.splice(0, 1000)
        if (level === 'error') logDebug(text)
        else logDebug(text)
    }
    function jobView(job) {
        return {
            id: job.id,
            kind: job.kind,
            status: job.status,
            lines: job.lines,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            result: job.result,
            error: job.error,
        }
    }
    async function runJob(job, fn) {
        try {
            await fn()
            job.status = job.cancelRequested ? 'aborted' : 'done'
        } catch (e) {
            if (job.cancelRequested) {
                job.status = 'aborted'
                job.error = null
            } else {
                job.error = e.message || String(e)
                job.status = 'error'
                jobLog(job, 'error', job.error)
                logDebug('job failed', e.stack || e)
            }
        } finally {
            if (!job.finishedAt) job.finishedAt = Date.now()
        }
    }

    
    
    
    function adminUsernames() {
        const names = new Set(['admin'])
        try {
            const accounts = api.getHfsConfig('accounts') || {}
            for (const [name, account] of Object.entries(accounts))
                if (account?.admin === true) names.add(String(name).toLocaleLowerCase())
        } catch {}
        return [...names]
    }
    function assertAdmin(ctx) {
        let ok = false
        try {
            const supplied = String(ctx.get?.('x-repair-token') || ctx.headers?.['x-repair-token'] || '')
            if (supplied && supplied.length === ADMIN_TOKEN.length
                && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(ADMIN_TOKEN))) return
        } catch {}
        try { ok = api.ctxBelongsTo(ctx, adminUsernames()) } catch {}
        if (!ok) {
            try {
                const usernames = ctx.state?.usernames
                if (usernames && typeof usernames.has === 'function')
                    ok = adminUsernames().some(name => usernames.has(name))
            } catch {}
        }
        if (!ok) {
            try {
                const username = api.getCurrentUsername?.(ctx)
                if (username) ok = api.getAccount?.(username)?.admin === true
            } catch {}
        }
        if (!ok) throw Error('admin only')
    }

    async function restScan(params, ctx) {
        assertAdmin(ctx)
        const deep = !!params?.deep
        const runningIds = Array.isArray(params?.runningIds) ? params.runningIds : []
        const job = createJob('scan')
        runJob(job, async () => {
            jobLog(job, 'info', `Scan plugin library: ${PLUGINS_ROOT}`)
            jobLog(job, 'info', `Config: ${CONFIG_PATH}`)
            const online = await loadOnlineCatalog({ refresh: !!params?.refreshOnline })
            if (job.cancelRequested) throw Error('Aborted by user')
            jobLog(job, 'dim', `Online list: ${online.source}, ${online.entries.length} repositories${online.updatedAt ? ' (updated ' + new Date(online.updatedAt).toLocaleString() + ')' : ''}`)
            const report = await buildReport({ deep: false, runningIds })
            if (job.cancelRequested) throw Error('Aborted by user')
            jobLog(job, 'dim', `Folders: ${report.items.length}; running: ${runningIds.length}; config sections: ${report.sectionCount}; orphans: ${report.orphans.config.length} config + ${report.orphans.enable.length} enable + ${report.orphans.keys?.length || 0} setting`)
            if (deep) await deepCheck(report.items, job)
            if (job.cancelRequested) throw Error('Aborted by user')
            if (deep) {
                const report2 = await buildReport({ deep: true, runningIds })
                Object.assign(report, report2)
            }
            if (job.cancelRequested) throw Error('Aborted by user')
            for (const it of report.items) {
                const tgt = it.target.id !== it.folder ? ` → ${it.target.id}` : ''
                const fix = it.fixes.length ? '  fixes:' + it.fixes.map(f => f.type).join('+') : ''
                if (it.severity === 'healthy') {
                    jobLog(job, 'ok', `[healthy] ${it.folder}${tgt}`)
                    continue
                }
                jobLog(job, it.severity === 'unhealthy' ? 'error' : it.severity === 'need-fix' ? 'warn' : 'dim',
                    `[${it.severity}] ${it.folder}${tgt}  ${it.tags.join(', ')}${fix}`)
            }
            jobLog(job, 'stat', `Stats: healthy ${report.stats.healthy}, needs fix ${report.stats.needFix}, unhealthy ${report.stats.unhealthy}, attention ${report.stats.attention}, suspect ${report.stats.suspect}`)
            job.result = report
        })
        return { ok: true, jobId: job.id }
    }

    async function restAbortJob(params, ctx) {
        assertAdmin(ctx)
        const job = jobs.get(String(params?.id || ''))
        if (!job) throw Error('job not found')
        if (job.kind !== 'scan') throw Error('this job cannot be aborted')
        if (job.status === 'running') {
            job.cancelRequested = true
            try { job.controller?.abort() } catch {}
            job.status = 'aborted'
            job.finishedAt = Date.now()
            job.result = { ok: false, aborted: true }
            jobLog(job, 'warn', 'Aborted by user')
        }
        return { ok: true, job: jobView(job) }
    }

    async function restJob(params, ctx) {
        assertAdmin(ctx)
        const job = jobs.get(String(params?.id || ''))
        if (!job) throw Error('job not found')
        return { ok: true, job: jobView(job) }
    }

    async function restApply(params, ctx) {
        assertAdmin(ctx)
        const job = createJob('apply')
        runJob(job, () => runApply(job, params || {}))
        return { ok: true, jobId: job.id }
    }

    async function restDecision(params, ctx) {
        assertAdmin(ctx)
        const id = String(params?.id || '')
        const decision = String(params?.decision || 'fix')
        if (!id) throw Error('missing id')
        if (!['fix', 'ignore', 'delete'].includes(decision)) throw Error('bad decision')
        const decisions = saveDecisions({ [id]: decision })
        return { ok: true, decisions }
    }

    async function restDecisions(params, ctx) {
        assertAdmin(ctx)
        return { ok: true, decisions: loadDecisions() }
    }

    async function restOnline(params, ctx) {
        assertAdmin(ctx)
        const optimizerSynced = !!params?.optimizerSynced
        const online = await loadOnlineCatalog({ refresh: true, search: !optimizerSynced })
        return { ok: true, source: online.source, count: online.entries.length, updatedAt: online.updatedAt, error: online.error || null, optimizerSynced }
    }

    async function restPrelude(params, ctx) {
        assertAdmin(ctx)
        const last = readJsonFile(LAST_BATCH_FILE, null)
        const mirror = readJsonFile(MIRROR_FILE, null)
        const online = readJsonFile(ONLINE_CACHE, null)
        const folders = listDirs(PLUGINS_ROOT)
        const entries = Array.isArray(mirror?.entries) ? mirror.entries
            : (Array.isArray(online?.entries) ? online.entries : [])
        const lastBatch = last ? {
            createdAt: last.createdAt || null,
            finishedAt: last.finishedAt || null,
            failed: !!last.failed,
            error: last.error || null,
            renamed: (last.renames || []).length,
            updated: (last.updates || []).length,
            deleted: (last.trash || []).length,
            merged: (last.results || []).filter(r => r.mergedInto).length,
            configBackup: last.configBackup || null,
            results: (last.results || []).length,
        } : null
        return {
            ok: true,
            version: exports.version,
            paths: {
                plugins: PLUGINS_ROOT,
                config: CONFIG_PATH,
                storage: storageDir,
                backup: BACKUP_DIR,
                trash: TRASH_DIR,
                mirror: MIRROR_FILE,
            },
            counts: {
                folders: folders.length,
                decisions: Object.keys(loadDecisions()).length,
                configSections: (() => {
                    try { return readConfigModel()?.doc?.plugins?.sections?.length || 0 } catch { return 0 }
                })(),
                enableEntries: (() => {
                    try { return readConfigModel()?.doc?.enable?.items?.length || 0 } catch { return 0 }
                })(),
            },
            online: {
                count: entries.length,
                updatedAt: mirror?.updatedAt || online?.updatedAt || null,
                source: mirror ? 'Plugins-Optimizer catalog' : (online ? 'online cache' : 'none'),
            },
            lastBatch,
            hfsPlugins: hfsPluginsAvailable,
        }
    }

    async function restSettings(params, ctx) {
        assertAdmin(ctx)
        return {
            ok: true,
            settings: pluginSettings(),
            backups: backupStats(),
            paths: { backup: BACKUP_DIR, pluginBackups: BACKUP_IN_SELF },
        }
    }

    async function restSaveSettings(params, ctx) {
        assertAdmin(ctx)
        const s = params?.settings || params || {}
        const backupTime = String(s.backupTime ?? '').trim()
        if (backupTime && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(backupTime))
            throw Error('Backup time must be HH:MM (e.g. 03:30) or empty')
        const limit = Math.min(500, Math.max(5, Number(s.backupLimit) || 30))
        const cleanList = v => String(v ?? '').split(',').map(x => x.trim()).filter(Boolean).join(',')
        api.setConfig('backupTime', backupTime)
        api.setConfig('backupLimit', limit)
        api.setConfig('ignoreFolders', cleanList(s.ignoreFolders))
        api.setConfig('ignorePlugins', cleanList(s.ignorePlugins))
        api.setConfig('debug', !!s.debug)
        return { ok: true, settings: pluginSettings(), backups: backupStats() }
    }

    async function restBackupNow(params, ctx) {
        assertAdmin(ctx)
        const bak = createConfigBackup()
        return { ok: true, backup: bak, backups: backupStats() }
    }

    async function restBackupCleanup(params, ctx) {
        assertAdmin(ctx)
        const mode = params?.mode === 'all' ? 'all' : 'old'
        const result = cleanupConfigBackups(mode)
        return { ok: true, mode, ...result, backups: backupStats() }
    }

    function loadOrderInfo() {
        const cfg = readConfigModel()
        const items = cfg?.doc?.enable?.items || []
        const seen = new Set()
        const entries = []
        for (const item of items) {
            if (seen.has(item.value)) continue
            seen.add(item.value)
            const dir = path.join(PLUGINS_ROOT, item.value)
            const file = path.join(dir, 'plugin.js')
            let version = null
            let mtime = null
            try {
                mtime = fs.statSync(file).mtimeMs
                version = parsePluginMeta(readText(file)).version
            } catch {}
            entries.push({
                id: item.value,
                missing: !isDir(dir),
                version,
                mtime,
            })
        }
        return { entries, config: CONFIG_PATH }
    }

    async function restLoadOrder(params, ctx) {
        assertAdmin(ctx)
        return { ok: true, ...loadOrderInfo() }
    }

    async function restSaveLoadOrder(params, ctx) {
        assertAdmin(ctx)
        const requested = Array.isArray(params?.order) ? params.order.map(String) : []
        const cfg = readConfigModel()
        if (!cfg?.doc?.enable) throw Error('enable_plugins block not found')
        const items = cfg.doc.enable.items
        const current = items.map(i => i.value)
        const unique = [...new Set(current)]
        if (!requested.length) throw Error('Empty plugin order')
        for (const id of requested) {
            if (!unique.includes(id)) throw Error(`Unknown enable_plugins entry: ${id}`)
        }
        for (const id of unique) {
            if (!requested.includes(id)) throw Error(`Missing enable_plugins entry: ${id}`)
        }
        const rawsByValue = new Map()
        for (const item of items) {
            if (!rawsByValue.has(item.value)) rawsByValue.set(item.value, [])
            rawsByValue.get(item.value).push(item.raw)
        }
        const orderedRaws = []
        for (const id of requested) {
            const list = rawsByValue.get(id) || []
            if (list.length) orderedRaws.push(list.shift())
        }
        for (const id of unique) {
            for (const raw of rawsByValue.get(id) || []) orderedRaws.push(raw)
        }
        if (orderedRaws.length !== items.length) throw Error('Plugin order count mismatch')
        const lines = cfg.doc.lines.slice()
        items.forEach((item, i) => { lines[item.line] = orderedRaws[i] })
        const text = lines.join(cfg.doc.eol || '\n')
        const check = parseDoc(text)
        const after = check?.enable?.items?.map(i => i.value) || []
        if (after.length !== current.length) throw Error('enable_plugins verification failed')
        const bak = writeConfigText(text)
        const live = liveEnableList()
        if (Array.isArray(live)) {
            const ordered = [...requested]
            for (const id of unique) if (!ordered.includes(id)) ordered.push(id)
            live.splice(0, live.length, ...ordered)
        }
        const info = loadOrderInfo()
        return { ok: true, ...info, backup: bak, order: requested }
    }

    async function restUndo(params, ctx) {
        assertAdmin(ctx)
        const job = createJob('undo')
        runJob(job, () => runUndo(job))
        return { ok: true, jobId: job.id }
    }

    async function restStatus(params, ctx) {
        assertAdmin(ctx)
        return {
            ok: true,
            version: exports.version,
            paths: { plugins: PLUGINS_ROOT, config: CONFIG_PATH, storage: storageDir, backup: BACKUP_DIR, mirror: MIRROR_FILE },
            counts: {
                decisions: Object.keys(loadDecisions()).length,
                jobs: jobs.size,
            },
            hfsPlugins: hfsPluginsAvailable,
            hfsApiKeys: hfsPlugins
                ? Object.keys(hfsPlugins).filter(k => /plugin|rescan/i.test(k)).slice(0, 30)
                : [],
            lastBatch: readJsonFile(LAST_BATCH_FILE, null) ? { exists: true } : { exists: false },
        }
    }

    
    
    
    function middleware(ctx) {
        if (ctx.method !== 'GET') return
        const assetMatch = String(ctx.path).match(/\/~\/plugins\/Plugins-Repair\/admin\.(js|css)$/)
        if (assetMatch) {
            const ext = assetMatch[1]
            const file = path.join(__dirname, 'public', ext === 'js' ? 'admin.js' : 'admin.css')
            return () => {
                ctx.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
                ctx.set('Pragma', 'no-cache')
                ctx.type = ext === 'js' ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8'
                ctx.body = exists(file) ? readText(file) : '/* missing */'
            }
        }
        if (ctx.path !== '/~/admin' && ctx.path !== '/~/admin/') return
        return () => {
            if (typeof ctx.body !== 'string' || ctx.body.includes('plugins-repair-admin')) return
            const base = (ctx.state?.revProxyPath || '') + '/~/plugins/' + PLUGIN_ID + '/'
            const v = encodeURIComponent(String(exports.version))
            const data = `<script>window.__REPAIR_TOKEN__=${JSON.stringify(ADMIN_TOKEN)}</script>`
            const tag = `<link rel="stylesheet" href="${base}admin.css?v=${v}"><script id="plugins-repair-admin" src="${base}admin.js?v=${v}"></script>`
            if (ctx.body.includes('</head>')) ctx.body = ctx.body.replace('</head>', data + tag + '</head>')
            else if (ctx.body.includes('</body>')) ctx.body = ctx.body.replace('</body>', data + tag + '</body>')
        }
    }

    
    
    
    ensureDir(storageDir)
    ensureDir(BACKUP_IN_SELF)
    const CONFIG_PATH = findConfigFile()
    function findConfigFile() {
        const candidates = [
            process.env.PLUGINS_REPAIR_CONFIG ? path.resolve(process.env.PLUGINS_REPAIR_CONFIG) : null,
            path.resolve(process.cwd(), CONFIG_NAME),
            path.join(HFS_ROOT, CONFIG_NAME),
            path.resolve(__dirname, '..', '..', CONFIG_NAME),
        ].filter(Boolean)
        for (const c of candidates) if (exists(c)) return c
        return path.join(HFS_ROOT, CONFIG_NAME)
    }
    loadDecisions()
    if (repoCacheDirty.value) writeJsonFile(REPO_CACHE, repoCache)

    setTimeout(() => {
        logDebug(`loaded v${exports.version}; plugins=${PLUGINS_ROOT}; config=${CONFIG_PATH}`)
    }, 1000)
    const autoBackupTimer = setInterval(maybeAutoBackup, 30000)
    autoBackupTimer.unref?.()
    const autoBackupKick = setTimeout(maybeAutoBackup, 5000)
    autoBackupKick.unref?.()

    async function retryDependencyFailures() {
        let mgr
        try { mgr = api.require('./plugins') } catch { return }
        if (!mgr?.isPluginRunning || !mgr?.getPluginInfo) return
        const enabled = () => liveEnableList()

        async function ensureDependency(repo, version, seen = new Set()) {
            if (!repo || seen.has(repo)) return false
            seen.add(repo)
            let p
            try { p = mgr.findPluginByRepo(repo) } catch { return false }
            if (!p?.id) return false
            const id = p.id
            let info
            try { info = mgr.getPluginInfo(id) } catch { info = null }
            for (const nested of Array.isArray(info?.depend) ? info.depend : []) {
                if (!await ensureDependency(nested.repo, nested.version, seen)) return false
            }
            if (!enabled().includes(id)) {
                try { mgr.enablePlugin(id, true) } catch (e) {
                    api.log(`Plugins Repair: cannot enable dependency ${id}: ${e?.message || e}`)
                    return false
                }
            }
            
            
            
            try {
                api.log(`Plugins Repair: restarting dependency ${id} for ${repo}`)
                if (mgr.isPluginRunning(id)) await mgr.stopPlugin(id)
                await mgr.startPlugin(id)
            } catch (e) {
                api.log(`Plugins Repair: dependency ${id} failed to restart: ${e?.message || e}`)
                return false
            }
            const now = mgr.getPluginInfo(id)
            if (version != null && Number(now?.version) < Number(version)) {
                api.log(`Plugins Repair: dependency ${id} is v${now?.version}, required v${version}`)
                return false
            }
            return mgr.isPluginRunning(id)
        }

        for (const id of enabled()) {
            if (id === PLUGIN_ID) continue
            let info
            try { info = mgr.getPluginInfo(id) } catch { continue }
            if (!info || mgr.isPluginRunning(id)) continue
            if (!/missing dependencies/i.test(String(info.error || ''))) continue
            const deps = Array.isArray(info.depend) ? info.depend : []
            if (!deps.length) continue
            let ready = true
            for (const dep of deps) {
                if (!await ensureDependency(dep.repo, dep.version)) { ready = false; break }
            }
            if (!ready) continue
            try {
                await mgr.startPlugin(id)
                api.log(`Plugins Repair: retried ${id} after its dependencies started`)
            } catch (e) {
                api.log(`Plugins Repair: retry failed for ${id}: ${e?.message || e}`)
            }
        }
    }

    const retryDependencyTimers = [6000, 15000, 30000].map(ms => {
        const t = setTimeout(retryDependencyFailures, ms)
        t.unref?.()
        return t
    })

    return {
        middleware,
        customRest: {
            pluginsRepair_scan: restScan,
            pluginsRepair_abortJob: restAbortJob,
            pluginsRepair_job: restJob,
            pluginsRepair_apply: restApply,
            pluginsRepair_decision: restDecision,
            pluginsRepair_decisions: restDecisions,
            pluginsRepair_online: restOnline,
            pluginsRepair_prelude: restPrelude,
            pluginsRepair_settings: restSettings,
            pluginsRepair_saveSettings: restSaveSettings,
            pluginsRepair_loadOrder: restLoadOrder,
            pluginsRepair_saveLoadOrder: restSaveLoadOrder,
            pluginsRepair_backupNow: restBackupNow,
            pluginsRepair_backupCleanup: restBackupCleanup,
            pluginsRepair_undo: restUndo,
            pluginsRepair_status: restStatus,
        },
        unload() {
            jobs.clear()
            try { clearInterval(autoBackupTimer) } catch {}
            try { clearTimeout(autoBackupKick) } catch {}
            for (const t of retryDependencyTimers) { try { clearTimeout(t) } catch {} }
        },
    }
}
