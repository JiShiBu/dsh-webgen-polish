# dsh-webgen-polish

**把一章中文正文切成几段，逐段交给网页版的 DeepSeek / Gemini / Venice 润色，收稿、落盘、合并、自检一条龙。**

不需要 API Key：它驱动你已经登录的浏览器（通过 Chrome DevTools 协议），把提示词填进网页输入框、点发送、等回复、把结果拿回来。

> DeepSeek Harness（DSH）插件，Host 侧运行。适用于「网页版模型比 API 更会写中文」的场景。

---

## 一、它解决什么问题

把长文丢给网页版模型润色，手工做一遍的流程是：切段 → 复制粘贴 → 等 → 复制回来 → 拼起来 → 检查有没有并段/重复/膨胀。一段一千多字，四段就是四轮，中间还要盯着别把上一段的内容混进来。

这个插件把这套流程做成接口：

- 一次提交多段，逐段发送、逐段收稿
- 每段独立落盘，最后合并成一份
- 自带跨段重复检测、硬约束自检（北方话、破折号、套话、膨胀、专名）
- 支持指定对话会话，整批章节待在同一会话里
- 全程可查：任务、进度、日志、会话台账

---

## 二、功能

| 功能 | 说明 |
|---|---|
| 多段批量润色 | 一次提交 N 段，串行发送，逐段落盘 |
| 三个后端 | DeepSeek 网页版、Gemini、Venice.ai |
| 会话管理 | `current`（不导航）/ `fixed`（跳到指定会话）/ `new`（开新会话） |
| 会话台账 | 每次任务结束把「用了哪个会话」写进 `sessions.jsonl` |
| 分段保持 | 提示词自带「保持原文分段」，落盘时按段自检并报警 |
| 重复检测 | 跨段相似（全文/拼接处/滑窗）出报告 |
| 硬约束自检 | 北方话、破折号、套话、字数膨胀、专名保留 |
| 自检探针 | 发一条带随机验证码的短消息，核对回显 |
| 防重复发送 | 发送前读回编辑器全文，首尾/长度/段落四项校验 |

---

## 三、工作原理

```
DSH Host
  └─ 插件 index.js
       ├─ HTTP 接口（本机 127.0.0.1，默认端口 9333）
       ├─ Chrome DevTools 协议 → 已登录的浏览器标签页
       │    ├─ 找到输入框、填入提示词
       │    ├─ 校验填入内容（首尾/长度/段落）
       │    ├─ 点发送 / 回车
       │    └─ 轮询 DOM 等待回复稳定
       └─ 落盘：每段一个 txt，加上合并稿与各类报告
```

它不模拟「人慢慢打字」，而是用 CDP 的受信任输入事件与剪贴板粘贴，因此网页端看到的是正常输入。

---

## 四、环境要求

- DeepSeek Harness（Host 侧插件，需能在 profile 里加载 bundle）
- Google Chrome（用于自动化；与日常浏览器的配置目录分开）
- Node.js 18+
- 已在该 Chrome 配置目录里登录目标站点（DeepSeek / Gemini / Venice）

---

## 五、安装

### 方式一：本地 link（开发/自用）

```bash
# 把本仓库放到任意目录，然后在 DSH 里以 link 方式安装
dsh plugin --profile <profile> add link:/绝对路径/dsh-webgen-polish
```

并在 profile 的 `package.json` 的 `dsh.profile.bundles` 里加入 `dsh-webgen-polish`。

### 方式二：DSH 插件管理面板

「设置 → 插件 → 安装」，选择本目录或 npm 包名。

安装后重启 DSH（或重新加载插件）生效。

---

## 六、配置

复制 `cordis.patch.yml.example` 为 `cordis.patch.yml` 后按需修改：

```yaml
- insert:
    - id: webgen-polish
      name: dsh-webgen-polish
      config:
        port: 9333                    # Chrome 调试端口
        chatUrl: 'https://chat.deepseek.com/'     # 空着或给根地址＝用当前会话
        geminiUrl: 'https://gemini.google.com/app/'
        veniceUrl: 'https://venice.ai/chat/agent'
        outDir: 'D:\polish-output'    # 产物目录
        timeoutSec: 900               # 单段等待上限
        chromePath: 'C:\Program Files\Google\Chrome\Application\chrome.exe'
        profileDir: 'C:\Users\你\.dsh\webgen-profile'
```

| 字段 | 说明 |
|---|---|
| `port` | Chrome 远程调试端口，插件通过它连浏览器 |
| `chatUrl` / `geminiUrl` / `veniceUrl` | 各后端的目标会话地址；给根地址或新会话入口表示「不导航，用当前标签页」 |
| `outDir` | 产物目录（每段 txt、合并稿、各类报告、会话台账） |
| `timeoutSec` | 单段等待回复的上限（长文建议 900 以上） |
| `chromePath` | Chrome 可执行文件 |
| `profileDir` | 自动化专用配置目录（登录状态存在这里） |
| `template` | 默认提示词模板（也可每次请求传入） |

---

## 七、接口

基址：`http://127.0.0.1:<port>/api/dsh-webgen-polish`
（`<port>` 为 DSH 的 Web 服务端口，不是 Chrome 调试端口）

### 提交任务

```
POST /run
```

```json
{
  "backend": "deepseek",
  "sessionMode": "current",
  "chunks": ["第一段正文", "第二段正文"],
  "stamp": "018",
  "title": "018 帝魂惊梦 故国如梦",
  "totalParts": 4,
  "partOffset": 0,
  "timeoutSec": 900
}
```

| 参数 | 说明 |
|---|---|
| `backend` | `deepseek` / `gemini` / `venice` |
| `chunks` | 正文段落数组；**一段一个元素**，段内换行原样保留 |
| `sessionMode` | `current` 不导航 / `fixed` 跳到指定会话（默认）/ `new` 开新会话 |
| `totalParts` | 本章一共几段（用于提示词里的「全章切 N 段，这是第 M 段」） |
| `partOffset` | 本次第一段之前已发过几段（第 1 段传 0） |
| `stamp` | 产物文件名前缀，也用作台账标识 |
| `title` | 章名，接在提示词抬头 |
| `context` | 资料包（人物/设定/红线），插在正文之前 |
| `template` | 自定义模板，支持 `{{total}}` `{{part}}` `{{title}}` `{{text}}` `{{context}}` |
| `strictFormat` | `true` 时落盘按段补「段首两个全角空格」 |
| `maxInflation` | 如 `0.3` 表示提示词要求不超过原文 130%；默认不限制 |
| `timeoutSec` | 单段等待上限 |
| `selftestCode` | 传了它就做验证码自检 |

返回：`{ "ok": true, "jobId": "job-xxxx" }`

### 查任务

```
GET /job?jobId=job-xxxx     # 单个任务的完整状态与日志
GET /jobs                   # 任务列表（精简）
POST /cancel {"jobId":"..."} # 取消
```

任务被清理后 `/job` 返回 `{ "ok": true, "status": "gone", "job": null }`，轮询脚本判 `status in (done/failed/cancelled/gone)` 即可收尾。

### 会话

```
GET  /session                       # 各标签页现状（轮数、字数、可见性）
POST /session/switch {"backend":"gemini","url":"https://gemini.google.com/app/<id>"}
GET  /sessions?stamp=018&limit=20   # 会话台账（读 outDir/sessions.jsonl）
GET  /page                          # 页面自检：用户消息条数、最后一条长度与首尾
GET  /health                        # 插件与浏览器状态
POST /selftest {"backend":"gemini"} # 发一条带随机验证码的短消息并核对回显
```

`/session/switch` 单次耗时 5–7 秒。用 Node 内置 `fetch`（keep-alive）连发时偶发空响应 400，改用 curl / Python requests 或每次新建连接即可。

---

## 八、会话管理（为什么要显式指定）

网页版的「新会话入口」和「具体会话」长得像，但语义完全不同：

| 站点 | 新会话入口 | 具体会话 |
|---|---|---|
| DeepSeek | `/` | `/a/chat/s/<id>` |
| Gemini | `/app` | `/app/<id>` |
| Venice | `/chat/agent` | `/chat/<id>` |

把入口当成固定会话去导航，结果就是**每跑一章开一个新会话**。所以插件把三种意图显式化：

- `sessionMode: "current"`：绝不导航，整批章节留在同一会话（推荐）
- `sessionMode: "fixed"`：导航到配置里那个具体会话
- `sessionMode: "new"`：主动开新会话，并把生成的 `<id>` 记下来

每次任务结束都会往 `outDir/sessions.jsonl` 追加一行：`stamp / backend / sessionUrl / sessionMode / parts / status`。

---

## 九、产物

`outDir` 下会得到：

```
018_part01.txt          每段一份
018_part02.txt
018_merged.txt          合并稿
018_重复检测.txt         跨段重复报告
018_硬约束自检.txt       北方话/破折号/套话/膨胀/专名
sessions.jsonl          会话台账
```

---

## 十、已知限制

1. **网页版有额度**：免费额度用完就发不出去，插件会报错而不是静默重试
2. **分段靠提示词劝**：模型偶尔还是会把短句并成一段，插件会在落盘时报警，但不会替你改写
3. **一次只有一个浏览器实例**：同一 Chrome 调试端口只能挂一个自动化实例
4. **长文慢**：一段 1200 字通常 40–90 秒，四段一章约 5 分钟
5. **Windows 优先**：Chrome 路径默认按 Windows 写，其他平台改 `chromePath`

---

## 十一、许可

MIT，见 [LICENSE](LICENSE)。
