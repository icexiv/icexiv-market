import { Show } from 'solid-js'
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from '../tooltip'

declare const __GIT_COMMIT__: string
declare const __GIT_COMMIT_SUBJECT__: string
declare const __GIT_COMMIT_DATE__: string

const REPO_COMMIT_URL = 'https://github.com/icexiv/icexiv-market/commit'

function formatCommitDate(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

/** 右上角的构建版本徽标：点击打开对应提交，悬停显示提交标题与时间。 */
export function BuildCommitLink() {
  const commit = () => __GIT_COMMIT__ || 'unknown'
  const subject = () => __GIT_COMMIT_SUBJECT__.trim()
  const date = () => formatCommitDate(__GIT_COMMIT_DATE__)

  return (
    <Tooltip placement="bottom" openDelay={200}>
      <TooltipTrigger
        as="a"
        href={`${REPO_COMMIT_URL}/${commit()}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`查看构建提交 ${commit()}`}
        class="hidden h-8 items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:inline-flex"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="h-3.5 w-3.5"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M3 12h6" />
          <path d="M15 12h6" />
        </svg>
        <span class="hidden font-mono sm:inline">{commit()}</span>
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent class="max-w-72 whitespace-normal">
          <Show when={subject()} fallback={<span class="font-mono">提交 {commit()}</span>}>
            <div class="font-medium">{subject()}</div>
            <div class="mt-1 font-mono opacity-80">
              {commit()}
              {date() ? ` · ${date()}` : ''}
            </div>
          </Show>
        </TooltipContent>
      </TooltipPortal>
    </Tooltip>
  )
}
