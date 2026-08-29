import { createConnection } from 'node:net'
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const port = Number(process.env.FACHE_PORT ?? 5173)
const url = `http://127.0.0.1:${port}/`
const pidFile = join(projectRoot, '.fache-vite.pid')
const logFile = join(projectRoot, '.fache-vite.log')

function isPortOpen() {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (open) => {
      socket.destroy()
      resolve(open)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(500, () => finish(false))
  })
}

function openPage() {
  if (process.env.FACHE_OPEN === '0') return
  if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
  else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
}

async function start() {
  if (await isPortOpen()) {
    console.log(`[fache] 已有页面服务运行中：${url}`)
    openPage()
    return
  }

  const viteBin = join(projectRoot, 'node_modules/vite/bin/vite.js')
  const logFd = openSync(logFile, 'a')
  const child = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port)], {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  closeSync(logFd)
  child.unref()
  writeFileSync(pidFile, `${child.pid}\n`)
  console.log(`[fache] 页面已后台启动：${url}`)
  console.log(`[fache] 日志：${logFile}`)
  console.log('[fache] 停止服务：npm run dev:stop')
  openPage()
}

function stop() {
  if (!existsSync(pidFile)) {
    console.log('[fache] 没有找到 dev:keep 启动的进程。')
    return
  }
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  try {
    process.kill(pid, 'SIGTERM')
    console.log(`[fache] 已停止页面服务（PID ${pid}）。`)
  } catch (error) {
    if (error?.code === 'ESRCH') console.log('[fache] 进程已经退出，清理旧记录。')
    else throw error
  } finally {
    unlinkSync(pidFile)
  }
}

const action = process.argv[2]
if (action === 'start') await start()
else if (action === 'stop') stop()
else {
  console.error('用法：node scripts/dev-keep.mjs <start|stop>')
  process.exitCode = 1
}
