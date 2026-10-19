const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const themeDir = path.join(root, 'src', 'renderer', 'themes', 'builtin')
const compat = require(path.join(root, 'src', 'renderer', 'theme', 'compat.js'))
const index = JSON.parse(fs.readFileSync(path.join(themeDir, 'index.json'), 'utf8'))
const allowedDensities = new Set(['compact', 'workbench', 'standard', 'relaxed'])
const allowedMotions = new Set(['off', 'subtle', 'standard'])
const interactionKinds = ['page', 'panel', 'hudTimeline', 'wizard', 'mixer']

assert.equal(index.themes.length, 16)
for (const entry of index.themes) {
  assert.ok(entry.v3, `${entry.id} missing v3 profile`)
  assert.ok(allowedDensities.has(entry.v3.density), `${entry.id} has invalid density`)
  assert.ok(allowedMotions.has(entry.v3.motion), `${entry.id} has invalid motion`)
  const v2 = JSON.parse(fs.readFileSync(path.join(themeDir, entry.file), 'utf8'))
  const theme = compat.convert(entry, v2)
  assert.equal(theme.id, entry.id)
  assert.equal(theme.defaultDensity, entry.v3.density)
  assert.equal(theme.motion, entry.v3.motion)
  assert.equal(theme.description, entry.v3.description)
  assert.ok(theme.colors.canvas && theme.colors.surface && theme.colors.textPrimary, `${entry.id} missing core colors`)
  assert.ok(theme.motionSpec && theme.motionSpec.presets['page-enter'], `${entry.id} missing motion presets`)
  for (const kind of interactionKinds) {
    const mapping = theme.interactions[kind]
    assert.ok(mapping, `${entry.id} missing interaction ${kind}`)
    for (const preset of Object.values(mapping)) assert.ok(theme.motionSpec.presets[preset], `${entry.id} interaction references missing preset`)
  }
  assert.equal(new Set(theme.tags).size, theme.tags.length, `${entry.id} tags are duplicated`)
}
console.log(`V2 compatibility profiles passed: ${index.themes.length} themes`)
