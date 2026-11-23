/* Plugins Repair - admin panel extension
 *
 * Injected into /~/admin/ by the plugin middleware.
 * Adds an "ANALYZE & REPAIR" tab to the Plugins page and a full analysis/repair panel.
 */
(function () {
    'use strict'
    if (!location.pathname.includes('/~/admin')) return

    const PLUGIN_ID = 'Plugins-Repair'
    const TAB_LABEL = 'ANALYZE & REPAIR'
    const API_BASE = (function () {
        const i = location.pathname.indexOf('/~/admin')
        const prefix = i >= 0 ? location.pathname.slice(0, i) : ''
        return location.origin + prefix + '/~/api/'
    })()

    const SEV_LABEL = {
        healthy: 'Healthy',
        'need-fix': 'Needs fix',
        unhealthy: 'Unhealthy',
        suspect: 'Suspect',
        attention: 'Attention',
    }
    const TAG_LABEL = {
        'repo-owner-alias': 'Repo owner alias',
        'repo-name-mismatch': 'Repo name mismatch',
        'repo-case-mismatch': 'Repo case mismatch',
        'folder-name-mismatch': 'Folder name mismatch',
        'folder-case-mismatch': 'Folder case mismatch',
        'folder-name-differs': 'Folder/repo name differs',
        'config-variant': 'Duplicate config section',
        'config-rename': 'Config key needs rename',
        'enable-variant': 'Enable entry case',
        'enable-duplicate': 'Duplicate enable entry',
        'local-newer': 'Local version newer',
        'local-older': 'Online version newer',
        'update-available': 'Update available',
        'no-repo': 'No repo declared',
        'no-plugin-js': 'Missing plugin.js',
        'broken-plugin-js': 'Broken plugin.js',
        'target-conflict': 'Target name conflict',
        'duplicate-install': 'Duplicate install',
        'duplicate-master': 'Master copy',
        'settings-conflict': 'Settings conflict',
        'config-orphan': 'Orphan config section',
        'enable-orphan': 'Orphan enable entry',
        'online-ambiguous': 'Ambiguous online match',
        'online-not-found': 'Online not found',
        'not-published': 'Not published',
        'config-orphan': 'Orphan config section',
        'enable-orphan': 'Orphan enable entry',
        'orphan-setting': 'Orphan setting',
    }

    const $ = (sel, root) => (root || document).querySelector(sel)
    const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)]
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    const fmtTime = t => {
        const d = new Date(t)
        const p = n => String(n).padStart(2, '0')
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }
    const fmtDate = t => {
        if (!t) return '—'
        const d = new Date(t)
        const p = n => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    function fmtRelative(t) {
        if (!t) return ''
        const diff = Date.now() - Number(t)
        if (!Number.isFinite(diff) || diff <= 0) return 'just now'
        const units = [
            [365 * 24 * 3600 * 1000, 'year'],
            [30 * 24 * 3600 * 1000, 'month'],
            [7 * 24 * 3600 * 1000, 'week'],
            [24 * 3600 * 1000, 'day'],
            [3600 * 1000, 'hour'],
            [60 * 1000, 'minute'],
        ]
        for (const [ms, name] of units) {
            if (diff >= ms) {
                const n = Math.floor(diff / ms)
                return `${n} ${name}${n === 1 ? '' : 's'} ago`
            }
        }
        return 'just now'
    }
    const shortText = s => {
        const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
        return t.length > 90 ? t.slice(0, 87) + '…' : t
    }

    const state = {
        tab: null,
        panel: null,
        tabsRoot: null,
        root: null,
        active: false,
        mounted: false,
        report: null,
        decisions: {},
        selected: new Set(),
        forceOnline: new Set(),
        filter: 'all',
        logRendered: 0,
        logEntries: [],
        activeOp: null,
        job: null,
        lastApplied: 0,
        busy: false,
        paneDisplays: new Map(),
        mountTimer: null,
        mode: 'repair',
        mobileView: 'log',
        preludeLoaded: false,
        preludeLoading: false,
        preludeToken: 0,
        settingsOpen: true,
        settingsLoaded: false,
        settingsLoading: false,
        nativeFullscreen: false,
        resumeChecked: false,
        sidebarEntry: null,
        sidebarPlugins: null,
        fullPage: false,
        sidebarPending: false,
        tabsDisplay: null,
        pageHeader: null,
        pageHeaderDisplay: null,
    }

    // ============================================================
    //  REST
    // ============================================================
    async function call(cmd, params, opts) {
        const timeout = (opts && opts.timeout) || 30000
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort('timeout'), timeout)
        try {
            const headers = { 'content-type': 'application/json', 'x-hfs-anti-csrf': '1' }
            if (window.__REPAIR_TOKEN__) headers['x-repair-token'] = window.__REPAIR_TOKEN__
            const res = await fetch(API_BASE + cmd, {
                method: 'POST',
                headers,
                credentials: 'same-origin',
                body: JSON.stringify(params || {}),
                signal: controller.signal,
            })
            const text = await res.text()
            let data
            try { data = text ? JSON.parse(text) : null } catch { data = text }
            if (!res.ok) {
                const msg = (data && (data.message || data.error)) || text || ('HTTP ' + res.status)
                throw new Error(typeof msg === 'string' ? msg.split('\n')[0] : ('HTTP ' + res.status))
            }
            return data
        } finally { clearTimeout(timer) }
    }
    const rest = (name, params, opts) => call('_' + name, params, opts)
    const adminGet = (cmd, params) => call(cmd, params || {}, { timeout: 20000 })

    // Plugins-Optimizer exposes its catalog/cache through its own admin REST API.
    // Prefer it over a second GitHub search: it already has the VPN proxy link,
    // the persistent catalog mirror and the raw-response cache.
    async function optimizerCall(name, params, timeout = 120000) {
        const token = window.__OPTIMIZER_TOKEN__
        if (!token) throw new Error('Plugins-Optimizer is not active')
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort('timeout'), timeout)
        try {
            const res = await fetch(API_BASE + '_' + name, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-hfs-anti-csrf': '1',
                    'x-optimizer-token': token,
                },
                credentials: 'same-origin',
                body: JSON.stringify(params || {}),
                signal: controller.signal,
            })
            const text = await res.text()
            let data
            try { data = text ? JSON.parse(text) : null } catch { data = text }
            if (!res.ok) {
                const msg = (data && (data.message || data.error)) || text || ('HTTP ' + res.status)
                throw new Error(typeof msg === 'string' ? msg.split('\n')[0] : ('HTTP ' + res.status))
            }
            return data
        } finally { clearTimeout(timer) }
    }

    // ============================================================
    //  Mount: tab + panel
    // ============================================================
    function findTablist() {
        const lists = $$('[role="tablist"]')
        return lists.find(list => {
            const texts = $$('[role="tab"]', list).map(b => b.textContent.trim())
            return texts.includes('Installed') && texts.includes('Get more')
        }) || (location.hash.includes('/plugins/installed') ? lists[0] || null : null)
    }

    function ensureTab(list) {
        if (!list) return
        let tab = $('[data-repair-tab]', list)
        if (!tab) {
            const native = list.querySelector('[role="tab"]')
            if (!native) return
            tab = native.cloneNode(true)
            tab.dataset.repairTab = '1'
            tab.classList.add('repair-tab')
            tab.classList.remove('Mui-selected')
            tab.removeAttribute('id')
            tab.removeAttribute('aria-controls')
            tab.setAttribute('aria-selected', 'false')
            tab.setAttribute('aria-label', TAB_LABEL)
            tab.tabIndex = -1
            tab.textContent = TAB_LABEL
            tab.style.order = '99'
            tab.addEventListener('click', ev => {
                ev.preventDefault()
                ev.stopPropagation()
                activate()
            })
            const indicator = $('.MuiTabs-indicator', list)
            if (indicator) list.insertBefore(tab, indicator)
            else list.appendChild(tab)
            if (!list.dataset.repairBound) {
                list.dataset.repairBound = '1'
                list.addEventListener('click', ev => {
                    const t = ev.target.closest && ev.target.closest('[role="tab"]')
                    if (t && t !== tab && state.active) deactivate()
                }, true)
            }
        }
        // Always keep ANALYZE & REPAIR as the last visible tab.
        tab.style.order = '99'
        const indicatorNow = $('.MuiTabs-indicator', list)
        if (indicatorNow) {
            if (tab.nextElementSibling !== indicatorNow) list.insertBefore(tab, indicatorNow)
        } else if (list.lastElementChild !== tab) {
            list.appendChild(tab)
        }
        state.tab = tab
        if (state.active) {
            tab.classList.add('Mui-selected')
            tab.setAttribute('aria-selected', 'true')
        }
        ensurePanel(list)
    }

    function ensurePanel(list) {
        const tabsRoot = list.closest('.MuiTabs-root')
        const root = tabsRoot && tabsRoot.parentElement
        if (!tabsRoot || !root) return
        state.tabsRoot = tabsRoot
        state.root = root
        if (state.panel && state.panel.isConnected && state.panel.parentElement === root) {
            // Never re-insert an already mounted panel except when a route change
            // left the native tab strip below it (Get/Updates pages re-render the
            // tabs as a later sibling). Moving it back above keeps the tabs on top
            // without resetting scroll on normal renders.
            if (tabsRoot.compareDocumentPosition(state.panel) & Node.DOCUMENT_POSITION_PRECEDING)
                root.insertBefore(state.panel, tabsRoot.nextSibling)
            if (!state.active) state.panel.style.display = 'none'
            return
        }
        const panel = document.createElement('div')
        panel.className = 'repair-panel'
        panel.id = 'repair-panel'
        panel.dataset.repairPanel = '1'
        panel.dataset.repairMobileView = state.mobileView
        panel.dataset.repairMode = state.mode
        panel.style.order = '2'
        panel.style.display = 'none'
        panel.innerHTML = shellHtml()
        root.insertBefore(panel, tabsRoot.nextSibling)
        state.panel = panel
        bindPanel(panel)
        if (!state.mounted) {
            state.mounted = true
            panel.dataset.theme = isDarkTheme() ? 'dark' : 'light'
        }
        refreshPanelTheme()
        if (state.report) renderAll()
    }

    // ============================================================
    //  Sidebar entry + full-page mode (no native tabs)
    // ============================================================
    function repairPageHref() {
        return location.pathname + '?pluginsRepair=1#/plugins/installed'
    }
    function isRepairPage() {
        try { return new URLSearchParams(location.search).has('pluginsRepair') } catch { return false }
    }
    function isPluginTreePage() {
        try { return new URLSearchParams(location.search).has('pluginTree') } catch { return false }
    }
    function optimizerSkillActive() {
        const panel = document.querySelector('#optimizer-skill-panel')
        if (panel && getComputedStyle(panel).display !== 'none') return true
        return !!document.querySelector('[data-optimizer-plugin-tree][data-active="1"]')
    }
    function exitOptimizerMode() {
        try {
            const native = [...document.querySelectorAll('[role="tab"]')].find(t =>
                !t.dataset.repairTab && !t.dataset.optimizerTab && !t.dataset.skillTab
                && /Installed/i.test(t.textContent || ''))
            if (native) native.click()
        } catch {}
        try {
            if (isPluginTreePage()) {
                const url = new URL(location.href)
                url.searchParams.delete('pluginTree')
                history.replaceState(history.state, '', url.pathname + url.search + url.hash)
            }
        } catch {}
    }
    function ensureSidebarEntry() {
        const name = document.querySelector('#hfs-name')
        const list = name?.closest('ul')
        if (!list) return
        if (!document.getElementById('repair-sidebar-style')) {
            const style = document.createElement('style')
            style.id = 'repair-sidebar-style'
            style.textContent = `
                .repair-sidebar-link .MuiListItemIcon-root svg { width: 22px; height: 22px; }
                .repair-sidebar-link[data-active="1"] { background-color: rgba(224,123,0,.10) !important; color: #e07b00 !important; }
                .repair-sidebar-link[data-active="1"] .MuiListItemIcon-root,
                .repair-sidebar-link[data-active="1"] .MuiListItemText-primary { color: #e07b00 !important; font-weight: 600; }
                body.repair-full-page #repair-panel { margin-top: 0; }
            `
            document.head.appendChild(style)
        }
        let btn = document.querySelector('[data-repair-sidebar]')
        if (btn && !list.contains(btn)) { btn.remove(); btn = null }
        const anchors = [...list.querySelectorAll('a')].filter(a => !a.hasAttribute('data-repair-sidebar'))
        const plugins = anchors.find(a => a.textContent.trim() === 'Plugins')
            || anchors.find(a => {
                const h = (a.getAttribute('href') || '').split('?')[0]
                return /#\/plugins$/.test(h) || h === '#/plugins'
            })
            || anchors.find(a => (a.getAttribute('href') || '').includes('/plugins') && !/pluginTree/i.test(a.getAttribute('href') || ''))
        if (!btn) {
            btn = document.createElement('a')
            btn.href = repairPageHref()
            btn.tabIndex = 0
            btn.dataset.repairSidebar = '1'
            btn.setAttribute('aria-label', 'Plugin Repair')
            btn.className = (plugins?.className || 'MuiButtonBase-root MuiListItemButton-root MuiListItemButton-gutters') + ' repair-sidebar-link'
            btn.classList.remove('Mui-selected')
            const iconClass = plugins?.querySelector('.MuiListItemIcon-root')?.className || 'MuiListItemIcon-root'
            const textClass = plugins?.querySelector('.MuiListItemText-root')?.className || 'MuiListItemText-root'
            const primaryClass = plugins?.querySelector('.MuiListItemText-primary')?.className || 'MuiTypography-root MuiTypography-body1 MuiListItemText-primary'
            btn.innerHTML = `<div class="${iconClass}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M21.7 6.3a5.5 5.5 0 0 1-7.2 6.6l-6.4 6.4a2 2 0 0 1-2.8-2.8l6.4-6.4A5.5 5.5 0 0 1 18.3 3l-2.9 2.9 1.7 1.7L20 4.7c.7.5 1.2 1 1.7 1.6z"/></svg></div><div class="${textClass}"><span class="${primaryClass}">Plugin Repair</span></div>`
            btn.addEventListener('click', ev => {
                ev.preventDefault()
                ev.stopPropagation()
                state.sidebarPending = true
                if (!location.hash.includes('/plugins/installed')) {
                    location.hash = '#/plugins/installed'
                    return
                }
                const tabs = findTablist()
                if (!tabs) return
                state.sidebarPending = false
                navigateToRepairPage()
            })
            if (plugins) plugins.insertAdjacentElement('afterend', btn)
            else list.appendChild(btn)
        }
        // Keep the shortcut directly below the native Plugins entry.
        if (plugins && btn.previousElementSibling !== plugins)
            plugins.insertAdjacentElement('afterend', btn)
        state.sidebarEntry = btn
        state.sidebarPlugins = plugins || null
        if (plugins) plugins.classList.add('repair-native-plugins-link')
        if (plugins && !plugins.dataset.repairSidebarBound) {
            plugins.dataset.repairSidebarBound = '1'
            plugins.addEventListener('click', () => {
                if (state.fullPage) deactivateFullPage()
            })
        }
        updateSidebarActive()
    }

    function updateSidebarActive() {
        if (!state.sidebarEntry) return
        const active = !!state.fullPage && location.hash.includes('/plugins/installed')
        state.sidebarEntry.dataset.active = active ? '1' : '0'
        if (active && state.sidebarPlugins) state.sidebarPlugins.classList.remove('Mui-selected')
    }

    function navigateToRepairPage() {
        if (!isRepairPage()) {
            try { history.pushState({ pluginsRepair: 1 }, '', repairPageHref()) } catch {
                location.href = repairPageHref()
                return
            }
        }
        activateFullPage()
    }

    function clearRepairPageRoute() {
        if (!isRepairPage()) return
        try {
            const url = new URL(location.href)
            url.searchParams.delete('pluginsRepair')
            history.replaceState(history.state, '', url.pathname + url.search + url.hash)
        } catch {}
    }

    function activateFullPage() {
        if (state.fullPage) return
        if (isPluginTreePage() || optimizerSkillActive()) {
            if (state.optimizerExitPending) return
            state.optimizerExitPending = true
            exitOptimizerMode()
            setTimeout(() => {
                state.optimizerExitPending = false
                activateFullPage()
            }, 40)
            return
        }
        const list = findTablist()
        if (!list) return
        ensurePanel(list)
        if (!state.panel) return
        if (!state.fullPage && state.tabsDisplay == null) {
            const current = state.tabsRoot ? state.tabsRoot.style.display : ''
            state.tabsDisplay = current === 'none' ? '' : current
        }
        state.fullPage = true
        state.active = true
        state.mode = 'repair'
        if (state.panel) state.panel.dataset.repairMode = 'repair'
        state.sidebarPending = false
        document.body.classList.add('repair-full-page')
        if (state.tabsRoot) {
            state.tabsRoot.style.display = 'none'
            const header = state.tabsRoot.previousElementSibling
            if (header && header.querySelector('h2')?.textContent.trim() === 'Plugins') {
                if (state.pageHeader !== header || state.pageHeaderDisplay == null) {
                    state.pageHeader = header
                    state.pageHeaderDisplay = header.style.display === 'none' ? '' : header.style.display
                }
                header.style.display = 'none'
            }
        }
        if (state.tab) {
            state.tab.classList.remove('Mui-selected')
            state.tab.setAttribute('aria-selected', 'false')
            state.tab.tabIndex = -1
        }
        state.panel.style.display = 'flex'
        hideNativePane()
        updateSidebarActive()
        renderAll()
        requestAnimationFrame(fitPanel)
        if (!state.report && !readRememberedJob()) printPrelude()
        setTimeout(() => { resumeJob() }, 120)
        setTimeout(() => {
            const backdrop = document.querySelector('.MuiBackdrop-root')
            if (backdrop) backdrop.click()
        }, 80)
    }

    function deactivateForOptimizer() {
        if (isRepairFullscreen()) exitRepairFullscreen()
        state.active = false
        if (state.tab) {
            state.tab.classList.remove('Mui-selected')
            state.tab.setAttribute('aria-selected', 'false')
            state.tab.tabIndex = -1
        }
        if (state.panel) state.panel.style.display = 'none'
        updateSidebarActive()
    }

    function deactivateFullPage({ clearRoute = true, forOptimizer = false } = {}) {
        if (state.fullPage && isRepairFullscreen()) exitRepairFullscreen()
        if (!state.fullPage) {
            if (clearRoute) clearRepairPageRoute()
            updateSidebarActive()
            return
        }
        state.fullPage = false
        state.active = false
        document.body.classList.remove('repair-full-page')
        if (!forOptimizer) {
            if (state.tabsRoot) {
                state.tabsRoot.style.display = state.tabsDisplay || ''
                state.tabsDisplay = null
            }
            if (state.pageHeader) {
                state.pageHeader.style.display = state.pageHeaderDisplay || ''
                state.pageHeader = null
                state.pageHeaderDisplay = null
            }
        }
        if (state.panel) state.panel.style.display = 'none'
        if (!forOptimizer) {
            restoreNativePane()
            const list = findTablist()
            const native = list && $$('[role="tab"]', list).find(t =>
                !t.dataset.repairTab && !t.dataset.optimizerTab && !t.dataset.skillTab)
            if (native) {
                native.classList.add('Mui-selected')
                native.setAttribute('aria-selected', 'true')
                native.tabIndex = 0
            }
            if (state.sidebarPlugins && location.hash.includes('/plugins/installed'))
                state.sidebarPlugins.classList.add('Mui-selected')
        }
        if (clearRoute) clearRepairPageRoute()
        updateSidebarActive()
        setIndicator()
    }

    function isPortraitMobile() {
        try { return window.matchMedia('(max-width: 720px) and (orientation: portrait)').matches } catch { return false }
    }

    function setMobileView(view) {
        state.mobileView = view === 'log' ? 'log' : 'results'
        if (state.panel) state.panel.dataset.repairMobileView = state.mobileView
        for (const b of $$('.repair-mobile-tab', state.panel || document)) {
            b.classList.toggle('on', b.dataset.mobileView === state.mobileView)
        }
    }

    function refreshPanelTheme() {
        if (!state.panel) return
        const theme = isDarkTheme() ? 'dark' : 'light'
        if (state.panel.dataset.theme !== theme) state.panel.dataset.theme = theme
    }

    function isDarkTheme() {        try {
            const bg = getComputedStyle(document.body).backgroundColor
            const m = bg.match(/\d+/g)
            if (!m) return true
            const [r, g, b] = m.map(Number)
            return (r * 299 + g * 587 + b * 114) / 1000 < 128
        } catch { return true }
    }

    function shellHtml() {
        return `
<div class="repair-head">
  <div class="repair-title">
    <div>
      <div class="repair-name">Plugin Repair <span>PLUGINS REPAIR</span></div>
      <div class="repair-sub">Online catalog × plugin folders × config.yaml</div>
    </div>
  </div>
  <div class="repair-actions">
    <button class="repair-btn" data-act="scan" title="Read-only scan of the local plugin library and config.yaml">Scan</button>
    <button class="repair-btn" data-act="deep" title="Sync the online catalog, then verify every repository and version against GitHub">Deep check</button>
    <button class="repair-btn repair-ghost" data-act="undo" title="Restore renames, settings and deletions from the previous batch">Undo last batch</button>
    <button class="repair-btn repair-primary" data-act="apply">Apply selected</button>
    <button class="repair-btn repair-fullscreen-btn" data-act="fullscreen" title="Enter fullscreen" aria-label="Fullscreen">Fullscreen</button>
  </div>
</div>
<div class="repair-stats" id="repair-stats"></div>
<section class="repair-config" id="repair-config">
  <div class="repair-config-head">
    <span>BACKEND SETTINGS · BACKUPS</span>
    <button class="repair-mini" data-act="settings-toggle">Hide</button>
  </div>
  <div class="repair-config-body" id="repair-config-body">
    <label>Daily backup time<input type="time" data-setting="backupTime" title="Local server time; empty disables automatic backups"></label>
    <label>Keep backups<input type="number" min="5" max="500" data-setting="backupLimit"></label>
    <label class="wide">Ignored folders<input type="text" data-setting="ignoreFolders" placeholder="Backup,PATCH"></label>
    <label class="wide">Ignored plugins<input type="text" data-setting="ignorePlugins" placeholder="plugin-id, another-plugin"></label>
    <label class="repair-config-check"><input type="checkbox" data-setting="debug"> Debug logging</label>
    <div class="repair-backup-info" id="repair-backup-info">Loading backups…</div>
    <div class="repair-backup-list" id="repair-backup-list"></div>
    <pre class="repair-settings-log" id="repair-settings-log" aria-live="polite"></pre>
    <div class="repair-config-actions">
      <button class="repair-btn" data-act="settings-save">Save settings</button>
      <button class="repair-btn" data-act="backup-now">Backup now</button>
      <button class="repair-btn" data-act="backup-clean-old">Clean old config backups</button>
      <button class="repair-btn repair-danger" data-act="backup-clean-all">Delete all config backups</button>
      <button class="repair-btn" data-act="settings-refresh">Refresh list</button>
    </div>
  </div>
</section>
<div class="repair-body">
  <div class="repair-mobile-switch" id="repair-mobile-switch">
    <button class="repair-mobile-tab on" data-mobile-view="log">Analysis log</button>
    <button class="repair-mobile-tab" data-mobile-view="results">Details</button>
  </div>
  <section class="repair-console">
    <div class="repair-console-head">
      <span>ANALYSIS LOG</span>
      <span class="repair-console-tools">
        <span id="repair-job-state" class="repair-job-state"></span>
        <button class="repair-mini" data-act="clear-log">Clear</button>
        <button class="repair-mini" data-act="copy-log">Copy</button>
      </span>
    </div>
    <pre id="repair-log" class="repair-log" aria-live="polite"></pre>
  </section>
  <section class="repair-results">
    <div class="repair-results-head">
      <div class="repair-filters" id="repair-filters"></div>
      <div class="repair-filter-actions" id="repair-filter-actions"></div>
    </div>
    <div class="repair-list" id="repair-list">
      <div class="repair-empty">Press Scan to start the three-way check.</div>
    </div>
  </section>
</div>
<div class="repair-foot">
  <span id="repair-foot-info"></span>
  <span class="repair-foot-note">config.yaml and plugin.js are backed up before writing. Deletions move to storage/trash.</span>
</div>`
    }

    function bindPanel(panel) {
        panel.addEventListener('click', ev => {
            const btn = ev.target.closest('[data-act]')
            if (btn && panel.contains(btn)) {
                ev.preventDefault()
                onAction(btn.dataset.act)
                return
            }
            const dec = ev.target.closest('[data-decision]')
            if (dec) {
                ev.preventDefault()
                setDecision(dec.dataset.id, dec.dataset.decision)
                return
            }
            const force = ev.target.closest('[data-force-online]')
            if (force) {
                ev.preventDefault()
                chooseForceOnline(force.dataset.forceOnline)
                return
            }
            const chk = ev.target.closest('[data-pick]')
            if (chk) {
                const id = chk.dataset.pick
                if (chk.checked) state.selected.add(id)
                else { state.selected.delete(id); state.forceOnline.delete(id) }
                renderFilters()
                updateFoot()
                return
            }
            const filter = ev.target.closest('[data-filter]')
            if (filter) {
                state.filter = filter.dataset.filter
                renderFilters()
                renderList()
                return
            }
            const mobileTab = ev.target.closest('.repair-mobile-tab[data-mobile-view]')
            if (mobileTab) {
                setMobileView(mobileTab.dataset.mobileView)
                return
            }
            const fold = ev.target.closest('[data-fold]')
            if (fold) {
                const card = fold.closest('.repair-card')
                if (card) card.classList.toggle('open')
                return
            }
        })
    }

    function activate() {
        const list = findTablist()
        if (!list) return
        ensurePanel(list)
        state.active = true
        state.mode = 'settings'
        if (state.panel) state.panel.dataset.repairMode = 'settings'
        if (state.tab) {
            state.tab.classList.add('Mui-selected')
            state.tab.setAttribute('aria-selected', 'true')
            state.tab.tabIndex = 0
        }
        for (const t of $$('[role="tab"]', list)) {
            if (t !== state.tab) {
                t.classList.remove('Mui-selected')
                t.setAttribute('aria-selected', 'false')
                t.tabIndex = -1
            }
        }
        state.panel.style.display = 'flex'
        hideNativePane()
        setIndicator()
        requestAnimationFrame(fitPanel)
        if (!state.settingsLoaded) loadSettings()
    }

    function deactivate() {
        if (isRepairFullscreen()) exitRepairFullscreen()
        state.active = false
        if (state.tab) {
            state.tab.classList.remove('Mui-selected')
            state.tab.setAttribute('aria-selected', 'false')
            state.tab.tabIndex = -1
        }
        if (state.panel) state.panel.style.display = 'none'
        restoreNativePane()
        const list = findTablist()
        const native = list && $$('[role="tab"]', list).find(t => !t.dataset.repairTab && !t.dataset.optimizerTab && !t.dataset.skillTab)
        if (native) {
            native.classList.add('Mui-selected')
            native.setAttribute('aria-selected', 'true')
            native.tabIndex = 0
        }
        setIndicator()
    }

    function setIndicator() {
        if (!state.tabsRoot) return
        const ind = $('.MuiTabs-indicator', state.tabsRoot)
        if (!ind) return
        const target = state.active && state.tab ? state.tab : null
        if (!target) return
        ind.style.left = target.offsetLeft + 'px'
        ind.style.width = target.offsetWidth + 'px'
    }

    function isRepairFullscreen() {
        return !!state.panel && (state.panel.classList.contains('repair-fullscreen')
            || document.fullscreenElement === state.panel)
    }

    function updateFullscreenButton() {
        const btn = state.panel?.querySelector('[data-act="fullscreen"]')
        if (!btn) return
        const on = isRepairFullscreen()
        btn.textContent = on ? 'Exit fullscreen' : 'Fullscreen'
        btn.title = on ? 'Exit fullscreen' : 'Enter fullscreen'
        btn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen')
    }

    function setRepairFullscreen(on) {
        const panel = state.panel
        if (!panel) return
        panel.classList.toggle('repair-fullscreen', on)
        document.body.classList.toggle('repair-fullscreen-active', on)
        updateFullscreenButton()
        requestAnimationFrame(fitPanel)
    }

    function exitRepairFullscreen() {
        if (state.panel && document.fullscreenElement === state.panel) {
            try { document.exitFullscreen().catch(() => {}) } catch {}
        }
        state.nativeFullscreen = false
        setRepairFullscreen(false)
    }

    async function toggleRepairFullscreen() {
        const panel = state.panel
        if (!panel) return
        if (isRepairFullscreen()) {
            if (document.fullscreenElement === panel) {
                try { await document.exitFullscreen() } catch {}
            }
            state.nativeFullscreen = false
            setRepairFullscreen(false)
            return
        }
        try {
            if (panel.requestFullscreen) {
                try {
                    await panel.requestFullscreen({ navigationUI: 'hide' })
                } catch {
                    await panel.requestFullscreen()
                }
                state.nativeFullscreen = true
            }
        } catch {
            state.nativeFullscreen = false
        }
        setRepairFullscreen(true)
    }

    document.addEventListener('fullscreenchange', () => {
        if (!state.panel) return
        if (document.fullscreenElement === state.panel) {
            state.nativeFullscreen = true
            setRepairFullscreen(true)
        } else if (state.nativeFullscreen) {
            state.nativeFullscreen = false
            setRepairFullscreen(false)
        }
    })
    document.addEventListener('keydown', ev => {
        if (ev.key === 'Escape' && state.panel?.classList.contains('repair-fullscreen')
            && document.fullscreenElement !== state.panel)
            setRepairFullscreen(false)
    })

    function fitPanel() {
        const panel = state.panel
        if (!panel || panel.style.display === 'none') return
        if (state.mode === 'settings') {
            panel.style.height = ''
            return
        }
        if (isRepairFullscreen()) {
            panel.style.height = ''
            return
        }
        const shortLandscape = window.innerHeight <= 560 && window.innerWidth >= 600
        if (window.innerWidth <= 720 && !shortLandscape) {
            panel.style.height = ''
            return
        }
        const top = panel.getBoundingClientRect().top
        const minimum = shortLandscape ? 160 : 430
        const height = Math.max(minimum, window.innerHeight - top - 8)
        panel.style.height = height + 'px'
    }

    let fitTimer = null
    window.addEventListener('resize', () => {
        if (fitTimer) clearTimeout(fitTimer)
        fitTimer = setTimeout(fitPanel, 120)
    })

    function hideNativePane() {
        if (!state.root || !state.tabsRoot) return
        for (const child of [...state.root.children]) {
            if (child === state.tabsRoot || child === state.panel) continue
            if (state.tabsRoot.compareDocumentPosition(child) & Node.DOCUMENT_POSITION_PRECEDING) continue
            if (!state.paneDisplays.has(child)) state.paneDisplays.set(child, child.style.display)
            child.style.display = 'none'
        }
    }
    function restoreNativePane() {
        if (!state.root) return
        for (const [child, display] of state.paneDisplays) {
            if (child.isConnected) child.style.display = display || ''
        }
        state.paneDisplays.clear()
    }

    // ============================================================
    //  Actions
    // ============================================================
    async function onAction(act) {
        if (state.busy && act !== 'clear-log' && act !== 'copy-log') return
        if (act === 'scan') return scan(false)
        if (act === 'deep') return deepCheck()
        if (act === 'apply') return applySelected()
        if (act === 'undo') return undoBatch()
        if (act === 'fullscreen') return toggleRepairFullscreen()
        if (act === 'toggle-select') return toggleSelection()
        if (act === 'settings-toggle') return setSettingsOpen(!state.settingsOpen)
        if (act === 'settings-save') return saveSettings()
        if (act === 'backup-now') return backupNow()
        if (act === 'backup-clean-old') return cleanupBackups('old')
        if (act === 'backup-clean-all') return cleanupBackups('all')
        if (act === 'settings-refresh') return loadSettings(true)
        if (act === 'clear-log') return clearLog()
        if (act === 'copy-log') return copyLog()
    }

    async function runningIds() {
        try {
            const data = await adminGet('get_plugins', {})
            return (data.list || []).filter(p => p.started).map(p => p.id)
        } catch { return [] }
    }

    function setSettingsOpen(open) {
        state.settingsOpen = !!open
        const body = $('#repair-config-body')
        if (body) body.style.display = open ? 'grid' : 'none'
        const btn = $('[data-act="settings-toggle"]', state.panel || document)
        if (btn) btn.textContent = open ? 'Hide' : 'Show'
        requestAnimationFrame(fitPanel)
    }

    const fmtBytes = n => {
        const v = Number(n) || 0
        if (v < 1024) return v + ' B'
        if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB'
        return (v / (1024 * 1024)).toFixed(1) + ' MB'
    }

    function settingsLog(level, text) {
        const el = $('#repair-settings-log')
        if (!el) return
        const div = document.createElement('div')
        div.className = 'repair-settings-line lv-' + level
        div.textContent = `[${fmtTime(Date.now())}] ${text}`
        el.appendChild(div)
        while (el.children.length > 120) el.removeChild(el.firstChild)
        el.scrollTop = el.scrollHeight
    }

    function renderSettings(data) {
        const settings = data.settings || {}
        for (const el of $$('[data-setting]', state.panel || document)) {
            const key = el.dataset.setting
            if (!(key in settings)) continue
            if (el.type === 'checkbox') el.checked = !!settings[key]
            else el.value = settings[key] ?? ''
        }
        const b = data.backups || {}
        const info = $('#repair-backup-info')
        if (info) {
            const c = b.config || {}
            const latest = c.latest
                ? ` · latest ${fmtDate(c.latest.mtime)} (${String(c.latest.name || '').replace(/^config\.yaml\.repair-bak-/, '')})`
                : ' · no config backups yet'
            info.innerHTML = `<b>${c.count || 0}</b> config backup(s) · ${fmtBytes(c.size)}${latest}` +
                ` · <b>${b.pluginJs?.count || 0}</b> plugin.js backup(s) · ${fmtBytes(b.pluginJs?.size)}`
        }
        const list = $('#repair-backup-list')
        if (list) {
            const files = b.config?.files || []
            list.innerHTML = files.length
                ? files.slice().reverse().map(f => `<div class="repair-backup-row"><code>${esc(f.name)}</code><span>${fmtBytes(f.size)} · ${fmtDate(f.mtime)}</span></div>`).join('')
                : '<div class="repair-backup-empty">No config backups in config-backup/</div>'
        }
        setSettingsOpen(state.settingsOpen)
    }

    async function loadSettings(force = false) {
        if (state.settingsLoading) return
        if (!force && state.settingsLoaded) return
        state.settingsLoading = true
        settingsLog('dim', 'Loading backend settings and backups…')
        try {
            const data = await rest('pluginsRepair_settings', {}, { timeout: 20000 })
            if (!state.panel) return
            state.settingsLoaded = true
            renderSettings(data)
            settingsLog('ok', `Loaded: ${data.backups?.config?.count || 0} config backup(s), ${data.backups?.pluginJs?.count || 0} plugin.js backup(s)`)
        } catch (e) {
            const info = $('#repair-backup-info')
            if (info) info.textContent = 'Settings unavailable: ' + e.message
            settingsLog('error', 'Load failed: ' + e.message)
        } finally {
            state.settingsLoading = false
        }
    }

    function settingsValue(key) {
        const el = state.panel?.querySelector(`[data-setting="${key}"]`)
        if (!el) return ''
        return el.type === 'checkbox' ? el.checked : el.value
    }

    async function saveSettings() {
        const btn = state.panel?.querySelector('[data-act="settings-save"]')
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…' }
        try {
            const data = await rest('pluginsRepair_saveSettings', {
                settings: {
                    backupTime: settingsValue('backupTime'),
                    backupLimit: settingsValue('backupLimit'),
                    ignoreFolders: settingsValue('ignoreFolders'),
                    ignorePlugins: settingsValue('ignorePlugins'),
                    debug: settingsValue('debug'),
                },
            }, { timeout: 20000 })
            renderSettings(data)
            state.settingsLoaded = true
            settingsLog('ok', 'Settings saved')
            toast('Backend settings saved', 'ok')
        } catch (e) {
            settingsLog('error', 'Save failed: ' + e.message)
            toast('Could not save settings: ' + e.message, 'error')
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Save settings' }
        }
    }

    async function backupNow() {
        settingsLog('info', 'Creating config backup…')
        try {
            const data = await rest('pluginsRepair_backupNow', {}, { timeout: 30000 })
            renderSettings({ settings: pluginSettingsFromForm(), backups: data.backups })
            settingsLog('ok', `Backup created: ${data.backup}`)
            toast('Config backup created', 'ok')
        } catch (e) {
            settingsLog('error', 'Backup failed: ' + e.message)
            toast('Backup failed: ' + e.message, 'error')
        }
    }

    function pluginSettingsFromForm() {
        return {
            backupTime: settingsValue('backupTime'),
            backupLimit: settingsValue('backupLimit'),
            ignoreFolders: settingsValue('ignoreFolders'),
            ignorePlugins: settingsValue('ignorePlugins'),
            debug: settingsValue('debug'),
        }
    }

    async function cleanupBackups(mode) {
        const all = mode === 'all'
        const ok = await confirmDialog({
            title: all ? 'Delete all config backups?' : 'Clean old config backups?',
            lines: all
                ? ['Every file in config-backup/ will be deleted.', 'Undo last batch may no longer be able to restore config.yaml.']
                : ['Backups beyond the "Keep backups" limit will be deleted.', 'The newest backups are kept.'],
            danger: all,
            confirmText: all ? 'Delete all' : 'Clean',
        })
        if (!ok) { settingsLog('dim', 'Cleanup cancelled'); return }
        settingsLog('info', `${all ? 'Delete all' : 'Clean old'} config backups requested…`)
        try {
            const data = await rest('pluginsRepair_backupCleanup', { mode }, { timeout: 30000 })
            renderSettings({ settings: pluginSettingsFromForm(), backups: data.backups })
            settingsLog(data.deleted ? 'ok' : 'warn',
                `${all ? 'Delete all' : 'Clean old'}: deleted ${data.deleted}, remaining ${data.remaining}`)
            toast(data.deleted
                ? `${all ? 'All' : 'Old'} backups cleaned (${data.deleted} deleted)`
                : 'No matching config backups to delete', data.deleted ? 'ok' : 'warn')
        } catch (e) {
            settingsLog('error', 'Cleanup failed: ' + e.message)
            toast('Cleanup failed: ' + e.message, 'error')
        }
    }

    async function printPrelude() {        if (state.report || state.busy || state.preludeLoading || state.preludeLoaded) return
        const token = ++state.preludeToken
        state.preludeLoading = true
        pushLocal('info', 'Plugin Repair ready — scan is manual. Press Scan to start.')
        try {
            const p = await rest('pluginsRepair_prelude', {}, { timeout: 15000 })
            if (token !== state.preludeToken || state.report || state.busy) return
            state.preludeLoaded = true
            pushLocal('dim', `Library: ${p.paths.plugins}`)
            pushLocal('dim', `config.yaml: ${p.paths.config} · ${p.counts.configSections} sections · ${p.counts.enableEntries} enable entries`)
            pushLocal('dim', `Folders on disk: ${p.counts.folders} · saved decisions: ${p.counts.decisions}`)
            pushLocal('dim', `Online: ${p.online.count} entries (${p.online.source})${p.online.updatedAt ? ' · updated ' + fmtDate(p.online.updatedAt) : ''}`)
            const lb = p.lastBatch
            if (lb) {
                const when = fmtDate(lb.finishedAt || lb.createdAt)
                pushLocal(lb.failed ? 'warn' : 'dim',
                    `Last batch: ${when} · ${lb.renamed} renamed, ${lb.updated} updated, ${lb.merged} merged, ${lb.deleted} deleted${lb.failed ? ' · FAILED: ' + (lb.error || '') : ''}`)
                if (lb.configBackup)
                    pushLocal('dim', `Last backup: ${String(lb.configBackup).split(/[\\/]/).pop()}`)
            } else {
                pushLocal('dim', 'Last batch: none yet')
            }
            pushLocal('info', 'Scan is manual: it reads folders + config.yaml only; Deep check also verifies GitHub.')
            pushLocal('dim', 'Safety: config.yaml/plugin.js are backed up before writing; deletions go to storage/trash; Undo last batch restores the previous operation.')
            pushLocal('dim', 'Tip: use Update / Not published / Orphan settings, and Ignore to defer an item.')
        } catch (e) {
            if (token === state.preludeToken) {
                state.preludeLoaded = true
                pushLocal('warn', 'Prelude unavailable: ' + e.message)
            }
        } finally {
            state.preludeLoading = false
        }
    }

    async function scan(deep, force, keepLog = false) {
        if (state.busy && !force) return
        setBusy(true, 'Scanning…')
        if (isPortraitMobile()) setMobileView('log')
        if (!keepLog) clearLog()
        state.preludeLoaded = true
        state.preludeToken++
        pushLocal('info', deep ? 'Deep check started (includes GitHub verification)…' : 'Scanning plugin library…')
        try {
            const running = await runningIds()
            const r = await rest('pluginsRepair_scan', { deep, runningIds: running, refreshOnline: false })
            rememberJob(r.jobId, 'scan')
            await pollJob(r.jobId)
        } catch (e) {
            pushLog({ t: Date.now(), level: 'error', text: 'Scan failed: ' + e.message })
        } finally {
            setBusy(false)
        }
    }

    async function syncOnline() {
        if (state.busy) return
        setBusy(true, 'Deep check: online catalog…')
        pushLocal('info', 'Deep check: refreshing the Plugins-Optimizer catalog through its proxy/cache…')
        let optimizerSynced = false
        try {
            try {
                const st = await optimizerCall('pluginsOptimizer_status', {}, 30000)
                const cacheInfo = st?.cache || {}
                pushLocal('dim', `Optimizer cache: ${cacheInfo.entries ?? 0} entries · catalog ${st?.catalog?.count ?? 0} repos`)
            } catch (e) {
                pushLocal('warn', 'Optimizer status unavailable: ' + e.message)
            }
            const r = await optimizerCall('pluginsOptimizer_syncCatalog', { force: true }, 300000)
            const count = r?.entries ?? r?.catalog?.count ?? 0
            pushLocal('ok', `Plugins-Optimizer catalog refreshed (${count} entries)`)
            optimizerSynced = true
        } catch (e) {
            pushLocal('warn', 'Plugins-Optimizer sync unavailable: ' + e.message + ' — using the built-in GitHub search')
        }
        try {
            const r = await rest('pluginsRepair_online', { optimizerSynced }, { timeout: 180000 })
            pushLocal(r.error ? 'warn' : 'ok', `Online list: ${r.source}, ${r.count} repositories${r.error ? ' (' + r.error + ')' : ''}`)
        } catch (e) {
            pushLocal('error', 'Sync failed: ' + e.message)
        } finally {
            setBusy(false)
        }
    }

    async function deepCheck() {
        if (state.busy) return
        if (!(state.activeOp?.kind === 'deep' && state.activeOp.phase === 'sync'))
            beginActiveOp({ kind: 'deep' })
        await syncOnline()
        if (state.busy) return
        pushLocal('info', 'Starting deep check (raw plugin.js probes + online versions)…')
        await scan(true, false, true)
    }

    const ACTIVE_JOB_KEY = 'pluginsRepair.activeJob'
    function writeActiveOp(op) {
        try { localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify(op)) } catch {}
    }
    function rememberJob(id, kind) {
        const existing = state.activeOp
        const op = {
            id,
            kind: existing?.kind === 'deep' ? 'deep' : kind,
            phase: 'job',
            preLog: (existing?.phase === 'sync' ? existing.preLog : state.logEntries.slice(-300)),
            startedAt: existing?.startedAt || Date.now(),
        }
        state.activeOp = op
        writeActiveOp(op)
    }
    function beginActiveOp(op) {
        state.activeOp = { ...op, phase: 'sync', preLog: state.logEntries.slice(-300), startedAt: Date.now() }
        writeActiveOp(state.activeOp)
    }
    function clearRememberedJob() {
        state.activeOp = null
        try { localStorage.removeItem(ACTIVE_JOB_KEY) } catch {}
    }
    function readRememberedJob() {
        try { return JSON.parse(localStorage.getItem(ACTIVE_JOB_KEY) || 'null') } catch { return null }
    }
    function restoreLog(entries) {
        const log = $('#repair-log')
        if (log) log.innerHTML = ''
        state.logRendered = 0
        state.logEntries = []
        for (const e of entries || []) {
            const div = document.createElement('div')
            div.className = 'repair-line lv-' + (e.level || 'info')
            div.innerHTML = `<span class="repair-time">${fmtTime(e.t)}</span><span class="repair-text">${esc(e.text)}</span>`
            if (log) log.appendChild(div)
            state.logEntries.push(e)
            state.logRendered++
        }
        if (log) log.scrollTop = log.scrollHeight
    }

    async function resumeJob() {
        if (state.resumeChecked) return
        if (state.mode !== 'repair') return
        state.resumeChecked = true
        const saved = readRememberedJob()
        if (!saved) return
        try {
            if (saved.phase === 'sync' && saved.kind === 'deep') {
                restoreLog(saved.preLog || [])
                state.activeOp = saved
                pushLocal('info', 'Deep check was interrupted by a page refresh; resuming the online sync…')
                await deepCheck()
                return
            }
            if (!saved.id) { clearRememberedJob(); return }
            restoreLog(saved.preLog || [])
            state.activeOp = saved
            const r = await rest('pluginsRepair_job', { id: saved.id })
            if (!r.job) { clearRememberedJob(); return }
            setBusy(true, `Resuming ${saved.kind || 'operation'}…`)
            pushLocal('info', `Resuming ${saved.kind || 'operation'} after page refresh…`)
            const job = await pollJob(saved.id)
            setBusy(false)
            if ((saved.kind === 'apply' || saved.kind === 'undo') && job?.result?.ok) {
                await scan(false, true)
            }
        } catch (e) {
            clearRememberedJob()
            setBusy(false)
            pushLocal('warn', 'Could not resume the previous job: ' + e.message)
        }
    }

    async function pollJob(jobId) {
        const started = Date.now()
        let seen = 0
        while (true) {
            const r = await rest('pluginsRepair_job', { id: jobId })
            const job = r.job
            for (let i = seen; i < job.lines.length; i++) pushLog(job.lines[i])
            seen = job.lines.length
            const stateEl = $('#repair-job-state')
            if (stateEl) stateEl.textContent = job.status === 'running' ? `running ${Math.round((Date.now() - started) / 1000)}s` : ''
            if (job.status !== 'running') {
                if (job.status === 'error') pushLocal('error', 'Job failed: ' + (job.error || 'unknown'))
                if (job.kind === 'scan' && job.result) {
                    state.report = job.result
                    applyDecisions(job.result)
                    state.selected.clear()
                    state.forceOnline.clear()
                    renderAll()
                }
                if ((job.kind === 'apply' || job.kind === 'undo') && job.result) {
                    state.lastApplied = (job.result.renamed || 0) + (job.result.deleted || 0) + (job.result.repo ? 1 : 0)
                    if (job.kind === 'apply' && job.result.ok) {
                        toast(`Done: ${job.result.renamed || 0} renamed, ${job.result.merged || 0} merged, ${job.result.deleted || 0} deleted`, 'ok')
                        showResultToast(job.result)
                    }
                }
                if (job.kind === 'undo' && job.result?.ok) toast('Previous batch undone', 'ok')
                clearRememberedJob()
                return job
            }
            await new Promise(r2 => setTimeout(r2, 350))
        }
    }

    function applyDecisions(report) {
        for (const it of report.items) {
            const d = state.decisions[it.id]
            if (d) it.decision = d
            else it.decision = it.decision || 'fix'
        }
    }

    async function chooseForceOnline(id) {
        const it = allItems().find(i => i.id === id)
        if (!it) return
        if (state.forceOnline.has(id)) {
            state.forceOnline.delete(id)
            state.selected.delete(id)
            renderFilters()
            renderList()
            updateFoot()
            toast('Online adoption cancelled', 'ok')
            return
        }
        state.forceOnline.add(id)
        state.selected.add(id)
        state.decisions[id] = 'fix'
        it.decision = 'fix'
        renderStats()
        renderFilters()
        renderList()
        updateFoot()
        toast(`Use online v${it.online?.version ?? '?'} selected`, 'ok')
        try { await rest('pluginsRepair_decision', { id, decision: 'fix' }) } catch {}
    }

    async function setDecision(id, decision) {
        const it = state.report
            ? (state.report.items.find(i => i.id === id)
                || state.report.orphans?.config?.find(i => i.id === id)
                || state.report.orphans?.enable?.find(i => i.id === id)
                || state.report.orphans?.keys?.find(i => i.id === id))
            : null
        state.forceOnline.delete(id)
        const prev = state.decisions[id] ?? it?.decision
        const wasIgnored = prev === 'ignore'
        const wasDelete = prev === 'delete'
        const picked = state.selected.has(id)
        let effective = decision
        let cancelled = null
        // Ignore toggles off; Delete and Fix toggle back to the neutral state.
        if (decision === 'ignore' && wasIgnored) effective = 'fix'
        else if (decision === 'delete' && wasDelete) {
            effective = 'fix'
            cancelled = 'Delete cancelled'
        } else if (decision === 'fix' && !wasDelete && !wasIgnored && picked) {
            effective = 'fix'
            cancelled = 'Fix cancelled'
        }
        state.decisions[id] = effective
        if (cancelled) state.selected.delete(id)
        else if (effective === 'delete') state.selected.add(id)
        else if (effective === 'ignore') state.selected.delete(id)
        else if (!picked) state.selected.add(id)
        if (it) it.decision = effective
        renderStats()
        renderFilters()
        renderList()
        updateFoot()
        if (cancelled) toast(cancelled, 'ok')
        else if (effective === 'ignore' && !wasIgnored) toast('Moved to the Ignored tab', 'ok')
        else if (wasIgnored && effective !== 'ignore') toast('Ignore undone — press Rescan to refresh', 'ok')
        else if (effective === 'delete') toast('Delete selected', 'ok')
        else toast('Fix selected', 'ok')
        try { await rest('pluginsRepair_decision', { id, decision: effective }) } catch (e) {
            state.decisions[id] = prev
            if (it) it.decision = prev
            toast('Could not save decision: ' + e.message, 'error')
            renderStats()
            renderFilters()
            renderList()
            updateFoot()
        }
    }

    async function selectCurrentFilter() {
        if (!state.report) return
        const list = visibleItems()
        const selectable = it => (it.fixes || []).some(f => !(f.type === 'update' && f.force))
        const candidates = list.filter(it =>
            (state.decisions[it.id] || it.decision) !== 'ignore'
            && (state.forceOnline.has(it.id) || selectable(it)))
        if (!candidates.length) {
            toast(`No selectable items in ${filterName(state.filter)}`, 'warn')
            return
        }
        const added = candidates.filter(it => !state.selected.has(it.id))
        if (!added.length) {
            toast(`All selectable items in ${filterName(state.filter)} are already selected`, 'ok')
            return
        }
        for (const it of added) state.selected.add(it.id)
        renderFilters()
        renderList()
        updateFoot()
        toast(`${filterName(state.filter)} — selected ${added.length} item(s)`, 'ok')
    }
    function selectNone() {
        state.selected.clear()
        state.forceOnline.clear()
        renderFilters()
        renderList()
        updateFoot()
    }

    function toggleSelection() {
        if (state.selected.size) {
            selectNone()
            toast('Selection cleared', 'ok')
        } else {
            selectCurrentFilter()
        }
    }

    function filterName(key) {
        return {
            all: 'all items',
            'need-fix': 'needs-fix',
            update: 'updates',
            unhealthy: 'unhealthy',
            attention: 'attention',
            'not-found': 'not published',
            suspect: 'suspect',
            healthy: 'healthy',
            ignored: 'ignored',
            orphans: 'orphans',
        }[key] || key
    }

    function selectedItems() {
        if (!state.report) return []
        const map = new Map(allItems().map(i => [i.id, i]))
        return [...state.selected].map(id => map.get(id)).filter(Boolean)
    }

    async function applySelected() {
        const items = selectedItems()
            .filter(it => (state.decisions[it.id] || it.decision || 'fix') !== 'ignore')
            .filter(it => {
                const dec = state.decisions[it.id] || it.decision || 'fix'
                if (dec === 'delete') return true
                return state.forceOnline.has(it.id)
                    || (it.fixes || []).some(f => !(f.type === 'update' && f.force))
            })
        if (!items.length) { toast('Nothing selected', 'warn'); return }
        const fixes = items.filter(i => (state.decisions[i.id] || i.decision) !== 'delete')
        const forceAdopt = fixes.filter(i => state.forceOnline.has(i.id))
        const dels = items.filter(i => (state.decisions[i.id] || i.decision) === 'delete')
        const renames = fixes.filter(i => i.fixes?.some(f => f.type === 'rename'))
        const repos = fixes.filter(i => i.fixes?.some(f => f.type === 'repo'))
        const cfg = fixes.filter(i => i.fixes?.some(f => f.type === 'config'))
        const ownerAliases = fixes.filter(i => i.tags?.includes('repo-owner-alias'))
        const settingsConflicts = fixes.reduce((n, i) => n + (i.settings?.conflicts?.length || 0), 0)
        const duplicateMerges = fixes.filter(i => i.fixes?.some(f => f.type === 'duplicate-merge'))
        const ok = await confirmDialog({
            title: 'Apply fixes',
            lines: [
                `${fixes.length} plugin fix(es): ${repos.length} repo, ${cfg.length} config migration`,
                ownerAliases.length ? `${ownerAliases.length} repo owner alias fix(es) (Hug3O → hugo529100)` : '',
                duplicateMerges.length ? `${duplicateMerges.length} duplicate merge(s): settings migrate into the master, duplicate moves to trash` : '',
                forceAdopt.length ? `${forceAdopt.length} plugin(s) will adopt the online plugin.js (local version was higher)` : '',
                settingsConflicts ? `${settingsConflicts} setting conflict(s): master values are kept` : '',
                `${renames.length} folder rename(s)`,
                `${dels.length} plugin(s) moved to trash (restorable from storage/trash)`,
                'config.yaml and plugin.js are backed up before writing.',
                items.length > 20 ? 'Large batch: try 2–3 plugins first and verify their settings migrated correctly.' : '',
            ].filter(Boolean),
            danger: dels.length > 0,
            confirmText: 'Apply',
        })
        if (!ok) return
        setBusy(true, 'Applying…')
        clearLog()
        pushLocal('info', `Applying ${items.length} item(s)…`)
        try {
            const running = await runningIds()
            const r = await rest('pluginsRepair_apply', {
                allowRename: true,
                runningIds: running,
                actions: items.map(it => ({
                    id: it.id,
                    decision: state.decisions[it.id] || it.decision || 'fix',
                    forceOnline: state.forceOnline.has(it.id),
                })),
            })
            rememberJob(r.jobId, 'apply')
            const job = await pollJob(r.jobId)
            if (job.result?.ok) {
                state.selected.clear()
                state.forceOnline.clear()
                setBusy(false)
                await scan(false, true)
            }
        } catch (e) {
            pushLocal('error', 'Apply failed: ' + e.message)
        } finally {
            setBusy(false)
        }
    }

    async function undoBatch() {
        const ok = await confirmDialog({
            title: 'Undo last batch',
            lines: ['Restore folder renames, plugin.js and config.yaml from the previous batch.', 'Manual edits made after that batch can be overwritten by the undo.'],
            danger: true,
            confirmText: 'Undo',
        })
        if (!ok) return
        setBusy(true, 'Undoing…')
        clearLog()
        try {
            const r = await rest('pluginsRepair_undo', {})
            rememberJob(r.jobId, 'undo')
            await pollJob(r.jobId)
            await scan(false)
        } catch (e) {
            pushLocal('error', 'Undo failed: ' + e.message)
        } finally { setBusy(false) }
    }

    // ============================================================
    //  Rendering
    // ============================================================
    function allItems() {
        if (!state.report) return []
        return [
            ...state.report.items,
            ...(state.report.orphans?.config || []),
            ...(state.report.orphans?.enable || []),
            ...(state.report.orphans?.keys || []),
        ]
    }

    function renderAll() {
        renderStats()
        renderFilters()
        renderList()
        updateFoot()
        fitPanel()
    }

    function renderStats() {
        const el = $('#repair-stats')
        if (!el || !state.report) return
        const s = state.report.stats
        const items = state.report.items
        const ignored = items.filter(i => (state.decisions[i.id] || i.decision) === 'ignore').length
        const chips = [
            ['total', 'Total', items.length, ''],
            ['healthy', 'Healthy', s.healthy, 'ok'],
            ['need-fix', 'Needs fix', s.needFix, 'warn'],
            ['unhealthy', 'Unhealthy', s.unhealthy, 'bad'],
            ['attention', 'Attention', s.attention, 'dim'],
            ['suspect', 'Suspect', s.suspect, 'dim'],
            ['ignored', 'Ignored', ignored, 'dim'],
            ['applied', 'Fixed (batch)', state.lastApplied, 'accent'],
        ]
        el.innerHTML = chips.map(([k, label, num, cls]) => `
            <span class="repair-stat ${cls}" data-stat="${k}"><b>${num}</b>${label}</span>`).join('') + `
            <span class="repair-stat-meta">
                <span>Online ${state.report.online?.count ?? 0} · ${esc(state.report.online?.source || '—')}</span>
                <span>${state.report.deep ? 'Deep check' : 'Local scan'} · ${fmtTime(state.report.finishedAt)}</span>
            </span>`
    }

    function renderFilters() {
        const el = $('#repair-filters')
        if (!el || !state.report) return
        const actions = $('#repair-filter-actions')
        const defs = [
            ['all', 'All'],
            ['need-fix', 'Needs fix'],
            ['update', 'Update'],
            ['unhealthy', 'Unhealthy'],
            ['attention', 'Attention'],
            ['not-found', 'Not published'],
            ['suspect', 'Suspect'],
            ['healthy', 'Healthy'],
            ['ignored', 'Ignored'],
            ['orphans', 'Orphan settings'],
        ]
        const aliasCount = state.report.items.filter(i =>
            i.tags?.includes('repo-owner-alias') && i.severity === 'attention'
            && (state.decisions[i.id] || i.decision) !== 'ignore').length
        el.innerHTML = defs.map(([k, label]) => {
            const n = filterCount(k)
            const extra = k === 'attention' && aliasCount
                ? `<em class="repair-chip-extra" title="Repo owner alias (Hug3O → hugo529100) included in Attention">${aliasCount} Hug3O</em>`
                : ''
            return `<button class="repair-chip ${state.filter === k ? 'on' : ''}" data-filter="${k}">${label}<b>${n}</b>${extra}</button>`
        }).join('') + (state.filter === 'ignored'
            ? `<button class="repair-chip repair-rescan" data-act="scan">Rescan</button>`
            : '')
        if (actions) {
            const count = state.selected.size
            const selectLabel = state.filter === 'all' ? 'Select all' : `Select ${filterName(state.filter)}`
            actions.innerHTML = `<button class="repair-chip repair-select-toggle ${count ? 'on' : ''}" data-act="toggle-select" title="Select every selectable item in the current filter">${count ? `Clear selection (${count})` : selectLabel}</button>`
        }
    }

    function filterCount(k) {
        if (!state.report) return 0
        const items = state.report.items
        const orphans = [...(state.report.orphans?.config || []), ...(state.report.orphans?.enable || []), ...(state.report.orphans?.keys || [])]
        if (k === 'all') return items.filter(i => (state.decisions[i.id] || i.decision) !== 'ignore').length
        if (k === 'orphans') return orphans.length
        if (k === 'ignored') return items.filter(i => (state.decisions[i.id] || i.decision) === 'ignore').length
        if (k === 'not-found') return items.filter(i => i.tags?.includes('online-not-found') || i.tags?.includes('not-published')).length
        if (k === 'update') return items.filter(i => i.tags?.includes('update-available')).length
        return items.filter(i => i.severity === k).length
    }

    function visibleItems() {
        if (!state.report) return []
        const items = state.report.items
        const orphans = [...(state.report.orphans?.config || []), ...(state.report.orphans?.enable || []), ...(state.report.orphans?.keys || [])]
        if (state.filter === 'orphans') return orphans
        if (state.filter === 'ignored') return items.filter(i => (state.decisions[i.id] || i.decision) === 'ignore')
        if (state.filter === 'not-found') return items.filter(i => i.tags?.includes('online-not-found') || i.tags?.includes('not-published'))
        if (state.filter === 'update') return items.filter(i => i.tags?.includes('update-available'))
        if (state.filter === 'all') return items.filter(i => (state.decisions[i.id] || i.decision) !== 'ignore')
        return items.filter(i => i.severity === state.filter)
    }

    function chip(label, cls) {
        return `<span class="repair-tag ${cls || ''}">${esc(label)}</span>`
    }

    function renderList() {
        const el = $('#repair-list')
        if (!el) return
        if (!state.report) {
            el.innerHTML = `<div class="repair-empty">Press Scan to start the three-way check.</div>`
            return
        }
        const list = visibleItems()
        if (!list.length) {
            el.innerHTML = `<div class="repair-empty">${state.filter === 'ignored'
                ? 'No ignored plugins. Choose Ignore on a card to move it here.'
                : 'No items in this category.'}</div>`
            return
        }
        el.innerHTML = list.map(renderCard).join('')
    }

    function renderCard(it) {
        const decision = state.decisions[it.id] || it.decision || 'fix'
        const sev = it.severity || 'attention'
        const picked = state.selected.has(it.id)
        const isOrphan = !!it.kind
        const fixes = it.fixes || []
        const normalFixes = fixes.filter(f => !(f.type === 'update' && f.force))
        const forceFix = fixes.find(f => f.type === 'update' && f.force)
        const forceSelected = state.forceOnline.has(it.id)
        const renameFix = fixes.find(f => f.type === 'rename')
        const repoFix = fixes.find(f => f.type === 'repo')
        const cfgFix = fixes.find(f => f.type === 'config')
        const target = it.target?.id && it.target.id !== it.folder ? it.target.id : ''
        const tags = (it.tags || []).map(t => chip(TAG_LABEL[t] || t, 'tag-' + t))
        const notesList = Array.isArray(it.notes) ? it.notes : (it.notes ? [it.notes] : [])
        const notes = notesList.map(n => `<div class="repair-note">• ${esc(n)}</div>`).join('')
        const repoLine = repoFix
            ? `<div class="repair-kv"><span>repo</span><div><code>${esc(repoFix.before)}</code> <i>→</i> <code>${esc(repoFix.after)}</code></div></div>`
            : `<div class="repair-kv"><span>repo</span><div><code>${esc(it.repo || '—')}</code></div></div>`
        const renameLine = renameFix
            ? `<div class="repair-kv"><span>folder</span><div><code>${esc(renameFix.before)}</code> <i>→</i> <code>${esc(renameFix.after)}</code> ${renameFix.optional ? chip('case only', 'tag-dim') : ''} ${renameFix.requiresStop ? chip('needs stop', 'tag-warn') : ''}</div></div>`
            : ''
        const cfgLine = cfgFix
            ? `<div class="repair-kv"><span>config</span><div><code>${esc(cfgFix.before)}</code> <i>→</i> <code>${esc(cfgFix.after)}</code> <span class="repair-muted">${it.config?.variants?.length ? 'merge ' + it.config.variants.length + ' section(s)' : ''}</span></div></div>`
            : `<div class="repair-kv"><span>config</span><div>${configStatusText(it)}</div></div>`
        const enLine = `<div class="repair-kv"><span>enable</span><div>${enableStatusText(it)}</div></div>`
        const onlineMissing = /not found|404/i.test(it.online?.error || '')
        const onlineLine = it.online?.error
            ? `<div class="repair-kv"><span>online</span><div class="${onlineMissing ? 'repair-warn' : 'repair-bad'}">${onlineMissing ? 'not found — possibly an unpublished prototype plugin' : esc(it.online.error)}</div></div>`
            : ''
        const metaHtml = isOrphan
            ? (it.kind === 'config-key-orphan'
                ? `<div class="repair-kv"><span>section</span><div><code>${esc(it.section)}</code></div></div>
      <div class="repair-kv"><span>setting</span><div><code>${esc(it.entryKey)}</code> <span class="repair-muted">(not declared by plugin)</span></div></div>`
                : `<div class="repair-kv"><span>${it.kind === 'config-orphan' ? 'section' : 'entry'}</span><div><code>${esc(it.key)}</code>${it.kind === 'config-orphan' ? ` <span class="repair-muted">${it.entries || 0} key(s)</span>` : ''}</div></div>`)
            : `${repoLine}${renameLine}
      <div class="repair-kv"><span>version</span><div>${versionLine(it)}</div></div>
      <div class="repair-kv"><span>plugin</span><div><code>v${esc(it.version ?? '—')}</code> <span class="repair-muted">· modified ${fmtDate(it.mtime)} (${fmtRelative(it.mtime)})</span></div></div>
      ${cfgLine}
      ${enLine}
      ${onlineLine}`
        const preview = it.config?.preview && (it.config.preview.before || it.config.preview.after)
            ? diffHtml(it.config.preview)
            : ''
        return `
<article class="repair-card sev-${sev} ${picked ? 'picked' : ''} ${decision === 'ignore' ? 'ignored' : ''}" data-id="${esc(it.id)}">
  <div class="repair-card-head">
    <input type="checkbox" class="repair-pick" data-pick="${esc(it.id)}" ${picked ? 'checked' : ''}>
    <span class="repair-sev sev-${sev}">${SEV_LABEL[sev] || sev}</span>
    <code class="repair-folder">${esc(it.folder || it.key || it.id)}</code>
    ${target ? `<span class="repair-arrow">→</span><code class="repair-target">${esc(target)}</code>` : ''}
    <span class="repair-tags">${tags.join('')}</span>
    ${it.running ? chip('running', 'tag-run') : ''}
  </div>
  <div class="repair-card-body">
    <div class="repair-meta">
      ${metaHtml}
    </div>
    ${settingsHtml(it)}
    ${duplicateHtml(it)}
    ${notes ? `<div class="repair-notes">${notes}</div>` : ''}
    ${preview ? `<div class="repair-fold" data-fold="1">Before / after preview <span>▾</span></div>${preview}` : ''}
  </div>
  <div class="repair-card-foot">
    <div class="repair-decide">
      <button class="repair-decide-btn ${decision === 'fix' && picked ? 'on-fix' : ''}" data-decision="fix" data-id="${esc(it.id)}" ${decision === 'ignore' || normalFixes.length ? '' : 'disabled'}>${decision === 'ignore' ? 'Undo ignore' : normalFixes.some(f => f.type === 'update') ? 'Update' : `Fix${normalFixes.length ? ` (${normalFixes.length})` : ''}`}</button>
      ${forceFix ? `<button class="repair-decide-btn ${forceSelected ? 'on-force' : ''}" data-force-online="${esc(it.id)}" title="Replace local v${esc(it.version ?? '?')} with online v${esc(it.online?.version ?? '?')} after a backup">Use online</button>` : ''}
      <button class="repair-decide-btn ${decision === 'ignore' ? 'on-ignore' : ''}" data-decision="ignore" data-id="${esc(it.id)}">Ignore</button>
      ${isOrphan ? '' : `<button class="repair-decide-btn ${decision === 'delete' ? 'on-delete' : ''}" data-decision="delete" data-id="${esc(it.id)}">Delete</button>`}
    </div>
    <div class="repair-card-hint">${decision === 'delete' ? 'Folder moves to storage/trash and can be undone' : decision === 'ignore' ? 'Ignored — Undo ignore to restore, then Rescan' : fixSummary(it)}</div>
  </div>
</article>`
    }

    function versionLine(it) {
        if (it.version == null && !it.online?.version) return '<span class="repair-muted">—</span>'
        const local = it.version == null ? '—' : esc(it.version)
        const online = it.online?.version == null ? '—' : esc(it.online.version)
        let extra = ''
        if (it.tags?.includes('local-newer')) extra = chip('local dev build newer', 'tag-attention')
        else if (it.tags?.includes('local-older')) extra = chip('update available', 'tag-warn')
        return `<code>${local}</code> <span class="repair-muted">/ online ${online}</span> ${extra}`
    }

    function configStatusText(it) {
        const s = it.config?.status
        if (s === 'exact') return `<code>${esc(it.config.key)}</code> <span class="repair-muted">(exact match)</span>`
        if (s === 'case') return `<code>${esc(it.config.key)}</code> <span class="repair-bad">(case mismatch)</span>`
        if (s === 'alias') return `<code>${esc(it.config.key)}</code> <span class="repair-bad">(alias name)</span>`
        return `<span class="repair-muted">No config section (defaults are used)</span>`
    }

    function enableStatusText(it) {
        if (!it.enable || it.enable.status === 'none') return '<span class="repair-muted">—</span>'
        const s = it.enable.status
        const val = (it.enable.entries || []).join(', ')
        if (s === 'exact') return `<code>${esc(val)}</code> <span class="repair-muted">(enabled)</span>`
        if (s === 'variant') return `<code>${esc(val)}</code> <span class="repair-bad">(case mismatch, not actually enabled)</span>`
        if (s === 'duplicate') return `<code>${esc(val)}</code> <span class="repair-bad">(duplicate entries)</span>`
        return `<span class="repair-muted">Not in enable_plugins (disabled)</span>`
    }

    function fixSummary(it) {
        const forceSelected = state.forceOnline.has(it.id)
        const f = (it.fixes || []).filter(x => !(x.type === 'update' && x.force) || forceSelected)
        if (!f.length) {
            const force = (it.fixes || []).find(x => x.type === 'update' && x.force)
            if (force) return `Local v${it.version} considered newer. Use online to adopt v${it.online?.version ?? '?'}.`
            return it.severity === 'healthy' ? 'Nothing to do' : 'No automatic fix available'
        }
        return 'Will run: ' + f.map(x => x.label || x.type).join(', ')
    }

    function settingsHtml(it) {
        const s = it.settings
        if (!s || s.mode === 'none' || (s.mode === 'single' && !s.keys)) return ''
        const label = { single: 'Single section', identical: 'Identical', mergeable: 'Mergeable', conflict: 'Conflict' }[s.mode] || s.mode
        const master = s.masterKey
            ? `<code>${esc(s.masterKey)}</code>${s.masterVersion != null ? ' v' + esc(s.masterVersion) : ''}${s.masterMtime ? ' · ' + fmtDate(s.masterMtime) : ''}`
            : '—'
        const conflicts = (s.conflicts || []).slice(0, 4).map(c => `
            <div class="repair-conflict"><code>${esc(c.key)}</code>
              <span class="repair-master-value">${esc(shortText(c.masterValue))}</span>
              <span class="repair-muted">vs</span>
              <code>${esc(c.otherKey)}</code>
              <span>${esc(shortText(c.otherValue))}</span>
            </div>`).join('')
        const more = (s.conflicts || []).length > 4
            ? `<div class="repair-muted">+${s.conflicts.length - 4} more conflict(s) — see Before/After</div>` : ''
        return `<div class="repair-settings mode-${s.mode}">
  <div class="repair-settings-head">
    <span class="repair-settings-mode">SETTINGS · ${esc(label)}</span>
    <span>master ${master}</span>
    <span class="repair-muted">${s.keys} keys · ${s.added} added · ${s.identical} identical · ${(s.conflicts || []).length} conflicts</span>
  </div>
  ${s.masterReason ? `<div class="repair-settings-reason">${esc(s.masterReason)}</div>` : ''}
  ${conflicts}
  ${more}
</div>`
    }

    function duplicateHtml(it) {
        const d = it.duplicateMaster
        if (!d) return ''
        const merge = it.mergeDuplicate
        if (!d.isMaster && merge) {
            const hasSettings = (merge.fromKeys || []).length > 0
            const from = (merge.fromKeys || []).join(', ')
            const reason = hasSettings
                ? `Settings from <code>${esc(from)}</code> merge into <code>${esc(merge.masterKey)}</code>; this folder then moves to trash.`
                : 'No config settings to migrate; this duplicate folder then moves to trash.'
            const counts = hasSettings
                ? `${merge.added} key(s) added · ${(merge.conflicts || []).length} conflict(s) keep master`
                : 'no config settings'
            const conflicts = (merge.conflicts || []).slice(0, 3).map(c => `
                <div class="repair-conflict"><code>${esc(c.key)}</code>
                  <span class="repair-master-value">${esc(shortText(c.masterValue))}</span>
                  <span class="repair-muted">vs</span>
                  <code>${esc(c.otherKey)}</code>
                  <span>${esc(shortText(c.otherValue))}</span>
                </div>`).join('')
            return `<div class="repair-settings mode-duplicate is-dupe">
  <div class="repair-settings-head">
    <span class="repair-settings-mode">MERGE RECOMMENDED</span>
    <span>Into master <code>${esc(d.folder)}</code> v${esc(d.version ?? '—')} · ${fmtDate(d.mtime)}</span>
    <span class="repair-muted">${counts}</span>
  </div>
  <div class="repair-settings-reason">${reason}</div>
  ${conflicts}
</div>`
        }
        const label = d.isMaster ? 'MASTER COPY' : 'DUPLICATE'
        const action = d.isMaster ? 'Keep this folder; duplicates merge into it' : 'Delete recommended'
        return `<div class="repair-settings mode-duplicate ${d.isMaster ? 'is-master' : 'is-dupe'}">
  <div class="repair-settings-head">
    <span class="repair-settings-mode">${label}</span>
    <span>${action}: <code>${esc(d.folder)}</code> v${esc(d.version ?? '—')} · ${fmtDate(d.mtime)}</span>
    <span class="repair-muted">${esc(d.reason || '')}</span>
  </div>
</div>`
    }

    function diffHtml(preview) {
        const before = esc(preview.before || '').split('\n')
        const after = esc(preview.after || '').split('\n')
        const removed = []
        const bCount = new Map()
        for (const l of before) {
            const n = bCount.get(l) || 0
            bCount.set(l, n + 1)
            if (n >= after.filter(x => x === l).length) removed.push(l)
        }
        const added = []
        const aCount = new Map()
        for (const l of after) {
            const n = aCount.get(l) || 0
            aCount.set(l, n + 1)
            if (n >= before.filter(x => x === l).length) added.push(l)
        }
        const render = (lines, side) => lines.map(l => `<div class="diff-line ${side === 'before' && removed.includes(l) ? 'del' : ''}${side === 'after' && added.includes(l) ? 'add' : ''}">${l || ' '}</div>`).join('')
        return `<div class="repair-diff">
  <div class="repair-diff-col"><div class="repair-diff-title">Before</div><pre>${render(before, 'before')}</pre></div>
  <div class="repair-diff-col"><div class="repair-diff-title">After</div><pre>${render(after, 'after')}</pre></div>
</div>`
    }

    function updateFoot() {
        const el = $('#repair-foot-info')
        if (!el) return
        el.textContent = `${state.selected.size} selected`
    }

    // ============================================================
    //  Console
    // ============================================================
    function clearLog() {
        const log = $('#repair-log')
        if (log) log.innerHTML = ''
        state.logRendered = 0
        state.logEntries = []
        state.preludeLoaded = false
        state.preludeToken++
    }
    function pushLocal(level, text) {
        pushLog({ t: Date.now(), level, text })
    }
    function pushLog(line) {
        const log = $('#repair-log')
        if (!log) return
        const nearBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 40
        const div = document.createElement('div')
        div.className = 'repair-line lv-' + (line.level || 'info')
        div.innerHTML = `<span class="repair-time">${fmtTime(line.t)}</span><span class="repair-text">${esc(line.text)}</span>`
        log.appendChild(div)
        state.logRendered++
        state.logEntries.push({ t: line.t, level: line.level || 'info', text: line.text })
        if (state.logEntries.length > 400) state.logEntries.shift()
        if (state.activeOp?.phase === 'sync') {
            state.activeOp.preLog = state.logEntries.slice(-300)
            writeActiveOp(state.activeOp)
        }
        if (nearBottom) log.scrollTop = log.scrollHeight
    }
    async function copyLog() {
        const log = $('#repair-log')
        if (!log) return
        try {
            await navigator.clipboard.writeText(log.innerText)
            toast('Analysis log copied', 'ok')
        } catch { toast('Copy failed (browser restriction)', 'warn') }
    }

    // ============================================================
    //  Dialogs / toast
    // ============================================================
    function toast(text, type) {
        let host = document.getElementById('repair-toast-host')
        if (!host) {
            host = document.createElement('div')
            host.id = 'repair-toast-host'
            document.body.appendChild(host)
        }
        const el = document.createElement('div')
        el.className = 'repair-toast ' + (type || '')
        el.textContent = text
        host.appendChild(el)
        setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300) }, 4200)
    }

    function confirmDialog({ title, lines, confirmText, danger }) {
        return new Promise(resolve => {
            const host = document.createElement('div')
            host.className = 'repair-modal-host'
            host.innerHTML = `
<div class="repair-modal ${danger ? 'danger' : ''}">
  <div class="repair-modal-title">${esc(title)}</div>
  <div class="repair-modal-body">${lines.map(l => `<div>• ${esc(l)}</div>`).join('')}</div>
  <div class="repair-modal-actions">
    <button class="repair-btn repair-ghost" data-modal="cancel">Cancel</button>
    <button class="repair-btn ${danger ? 'repair-danger' : 'repair-primary'}" data-modal="ok">${esc(confirmText || 'Confirm')}</button>
  </div>
</div>`
            document.body.appendChild(host)
            const close = v => { host.remove(); resolve(v) }
            host.addEventListener('click', ev => {
                const b = ev.target.closest('[data-modal]')
                if (!b) { if (ev.target === host) close(false); return }
                close(b.dataset.modal === 'ok')
            })
        })
    }

    function showResultToast(result) {
        const lines = []
        if (result.renamed) lines.push(`${result.renamed} folder(s) renamed with settings migrated`)
        if (result.merged) lines.push(`${result.merged} duplicate(s) merged into master and moved to storage/trash`)
        if (result.deleted) lines.push(`${result.deleted} plugin(s) moved to storage/trash`)
        if (result.backup) lines.push(`config backup: ${result.backup}`)
        if (result.restartRequired) lines.push('Restart HFS for full effect')
        if (lines.length) toast(lines.join('; '), result.restartRequired ? 'warn' : 'ok')
    }

    function setBusy(busy, label) {
        state.busy = busy
        document.body.classList.toggle('repair-busy', busy)
        const el = $('#repair-job-state')
        if (el) el.textContent = busy ? (label || 'Working…') : ''
        for (const b of $$('.repair-actions .repair-btn')) {
            if (b.dataset.act === 'fullscreen') continue
            b.disabled = busy
        }
    }

    // ============================================================
    //  Routing / mounting loop
    // ============================================================
    function onRoute() {
        const installed = location.hash.includes('/plugins/installed')
        ensureSidebarEntry()
        if (isRepairPage() && installed) {
            ensureMounted()
            if (!state.fullPage) activateFullPage()
            return
        }
        if (isPluginTreePage()) {
            if (state.fullPage) deactivateFullPage({ clearRoute: false, forOptimizer: true })
            else if (state.active) deactivateForOptimizer()
            return
        }
        if (!installed) {
            if (state.fullPage) deactivateFullPage({ clearRoute: true })
            if (state.active && !state.fullPage) deactivate()
            return
        }
        ensureMounted()
        if (state.sidebarPending) {
            state.sidebarPending = false
            navigateToRepairPage()
            return
        }
        if (state.fullPage) deactivateFullPage({ clearRoute: false })
    }

    function ensureMounted() {
        const list = findTablist()
        if (!list) return
        ensureSidebarEntry()
        ensureTab(list)
    }

    window.addEventListener('hashchange', () => setTimeout(onRoute, 60))
    window.addEventListener('popstate', () => setTimeout(onRoute, 60))
    if (!window.__repairRouteHooked) {
        window.__repairRouteHooked = true
        for (const method of ['pushState', 'replaceState']) {
            const original = history[method]
            history[method] = function (...args) {
                const result = original.apply(this, args)
                window.dispatchEvent(new Event('repair:route'))
                return result
            }
        }
    }
    window.addEventListener('repair:route', () => setTimeout(onRoute, 0))
    const mo = new MutationObserver(() => {
        if (state.mountTimer) return
        state.mountTimer = setTimeout(() => {
            state.mountTimer = null
            ensureSidebarEntry()
            if (isPluginTreePage()) return
            if (location.hash.includes('/plugins/installed')) ensureMounted()
        }, 250)
    })
    try { mo.observe(document.body, { childList: true, subtree: true }) } catch {}
    setInterval(() => {
        ensureSidebarEntry()
        refreshPanelTheme()
        if (isPluginTreePage()) {
            if (state.fullPage) deactivateFullPage({ clearRoute: false, forOptimizer: true })
            else if (state.active) deactivateForOptimizer()
            return
        }
        if (location.hash.includes('/plugins/installed')) ensureMounted()
        if (state.fullPage) {
            if (state.tabsRoot && state.tabsRoot.style.display !== 'none') state.tabsRoot.style.display = 'none'
            if (state.panel && state.panel.style.display !== 'flex') state.panel.style.display = 'flex'
            if (state.panel) hideNativePane()
        } else if (state.active && state.tabsRoot) setIndicator()
    }, 1200)

    setTimeout(() => { onRoute() }, 600)
})()
