import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { YAML } from 'bun'
import { resolveSiteTarget } from '../app/site-target'

test('the default site target is international', () => {
  assert.equal(resolveSiteTarget(undefined), 'global')
})

test('both deployment targets can be selected explicitly', () => {
  assert.equal(resolveSiteTarget('cn'), 'cn')
  assert.equal(resolveSiteTarget('global'), 'global')
})

test('invalid targets fail instead of silently omitting domestic filing information', () => {
  for (const value of ['', 'china', 'intl', 'CN', ' global ', 'production']) {
    assert.throws(() => resolveSiteTarget(value), /Invalid VITE_SITE_TARGET/)
  }
})

interface Step {
  uses?: string
  run?: string
  if?: string
  env?: Record<string, string>
  with?: Record<string, string>
}

interface Job {
  if?: string
  needs?: string
  env?: Record<string, string>
  outputs?: Record<string, string>
  steps: Step[]
}

const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf-8')) as {
  jobs: Record<string, Job>
}

test('one build job produces both site targets', () => {
  const builds = workflow.jobs.build.steps.filter(step => step.run === 'bun run build')
  assert.equal(builds.length, 2)
  assert.equal(builds[0].env?.VITE_SITE_TARGET, 'global')
  assert.equal(builds[0].env?.BASE_URL, '/icexiv-market/')
  assert.equal(builds[1].env?.VITE_SITE_TARGET, 'cn')
  assert.equal(builds[1].env?.BASE_URL, '/')
  assert.equal(workflow.jobs.build.outputs?.['site-target'], undefined)
})

test('both deployments run in parallel from the shared build', () => {
  assert.equal(workflow.jobs.deploy.needs, 'build')
  assert.equal(workflow.jobs['deploy-server'].needs, 'build')
  assert.equal(workflow.jobs['deploy-server'].if, undefined)
  assert.ok(workflow.jobs.deploy.steps.some(step =>
    step.uses?.startsWith('actions/deploy-pages@')))
  assert.ok(workflow.jobs['deploy-server'].steps.some(step =>
    step.run?.includes('/srv/market.icexiv.top/www')))
})

test('domestic and international artifacts are uploaded separately', () => {
  const pagesUpload = workflow.jobs.build.steps.find(step =>
    step.uses?.startsWith('actions/upload-pages-artifact@'))
  assert.ok(pagesUpload)
  const serverUpload = workflow.jobs.build.steps.find(step =>
    step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === 'site-dist')
  assert.ok(serverUpload)
  assert.equal(serverUpload.if, undefined)
  assert.ok(!workflow.jobs.deploy.steps.some(step => step.run?.includes('purge-cdn')))
})
