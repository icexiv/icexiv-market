// 两个备案号填在下面，填好即自动出现在每页页脚（公安号为空时该行不渲染）。
// "悬挂备案号"是法定义务：ICP 备案号必须能点进工信部备案系统，
// 公安备案号必须能点进公安备案查询页，缺一样都可能被责令改正。

/** 必须与工信部公共查询结果逐字一致（含 -1 之类的网站序号后缀） */
const ICP_LICENSE: string = '京ICP备2026077264号-1'
/** 例如：沪公网安备 31010502000000号 */
const POLICE_LICENSE: string = ''

const ICP_URL = 'https://beian.miit.gov.cn/'
/** 公安备案查询页只认纯数字编号，从上面的全称里取 */
const policeCode = () => POLICE_LICENSE.replace(/\D/g, '')
const POLICE_URL = () => `https://beian.mps.gov.cn/#/query/webSearch?code=${policeCode()}`

const linkClass =
  'transition-colors hover:text-foreground underline-offset-4 hover:underline'

export function SiteFooter() {
  return (
    <footer class="border-t">
      <div class="mx-auto flex max-w-7xl flex-col items-center gap-1 px-4 py-6 text-xs text-muted-foreground sm:px-6 lg:px-8">
        {ICP_LICENSE && (
          <a href={ICP_URL} target="_blank" rel="noopener noreferrer" class={linkClass}>
            {ICP_LICENSE}
          </a>
        )}
        {POLICE_LICENSE && (
          <a href={POLICE_URL()} target="_blank" rel="noopener noreferrer" class={linkClass}>
            {POLICE_LICENSE}
          </a>
        )}
      </div>
    </footer>
  )
}
