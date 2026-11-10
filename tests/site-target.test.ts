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

test('Pages builds only the international target', () => {
  const builds = Object.values(workflow.jobs).flatMap(job => job.steps)
    .filter(step => step.run === 'bun run build')
  assert.equal(builds.length, 1)
  assert.equal(workflow.jobs.build.env?.VITE_SITE_TARGET, 'global')
  assert.equal(builds[0].env?.VITE_SITE_TARGET, undefined)
  assert.equal(workflow.jobs.build.outputs?.['site-target'], '${{ env.VITE_SITE_TARGET }}')
  assert.equal(workflow.jobs.deploy.needs, 'build')
  assert.ok(workflow.jobs.deploy.steps.some(step => step.uses?.startsWith('actions/deploy-pages@')))
})

test('international artifacts are not uploaded or deployed to the domestic server', () => {
  assert.equal(workflow.jobs['deploy-server'].if, "${{ needs.build.outputs.site-target == 'cn' }}")
  const serverUpload = workflow.jobs.build.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))
  assert.ok(serverUpload)
  assert.equal(serverUpload.if, "${{ env.VITE_SITE_TARGET == 'cn' }}")
  assert.ok(!workflow.jobs.deploy.steps.some(step => step.run?.includes('purge-cdn')))
})
