/* Workspace Profile runtime: V4 and V7 are layout profiles, independent from palette themes. */
(() => {
  const STORAGE_KEY = 'hdsi-workspace-profile'
  const DEFAULT_PROFILE = 'v4'
  const PROFILES = Object.freeze([
    { id: 'v4', name: 'V4 · Information Studio', shortName: 'V4 · 信息工作台', description: '同时显示更多状态，适合监控与排错。' },
    { id: 'v7', name: 'V7 · Data State Surface', shortName: 'V7 · 数据状态界面', description: '以趋势、状态机和事件信号替代传统时间轴。' },
  ])

  const valid = value => PROFILES.some(profile => profile.id === value)
  const read = () => {
    try { return localStorage.getItem(STORAGE_KEY) } catch { return null }
  }
  const write = value => {
    try { localStorage.setItem(STORAGE_KEY, value) } catch { /* private mode / restricted storage */ }
  }
  const current = () => valid(document.documentElement.dataset.hdsiWorkspace) ? document.documentElement.dataset.hdsiWorkspace : DEFAULT_PROFILE
  const apply = value => {
    const next = valid(value) ? value : DEFAULT_PROFILE
    document.documentElement.dataset.hdsiWorkspace = next
    write(next)
    document.dispatchEvent(new CustomEvent('hdsi-workspace-profile-change', { detail: { profile: next } }))
    return next
  }
  const restore = () => apply(valid(read()) ? read() : DEFAULT_PROFILE)
  const reset = () => apply(DEFAULT_PROFILE)

  // Set the attribute before the rest of the renderer initializes, so the first
  // layout frame is deterministic and never briefly paints V4 as V7 (or vice versa).
  if (!valid(document.documentElement.dataset.hdsiWorkspace)) document.documentElement.dataset.hdsiWorkspace = DEFAULT_PROFILE
  window.HDSIWorkspaceProfile = Object.freeze({
    STORAGE_KEY,
    DEFAULT_PROFILE,
    list: () => PROFILES.slice(),
    current,
    apply,
    restore,
    reset,
  })
  restore()
})()
