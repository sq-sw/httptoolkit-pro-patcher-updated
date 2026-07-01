// @ts-check
import { spawn } from 'child_process'
import asar from '@electron/asar'
import prompts from 'prompts'
import yargs from 'yargs'
import chalk from 'chalk'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { flipFuses, getCurrentFuseWire, FuseV1Options, FuseVersion } from '@electron/fuses'

const argv = await yargs(process.argv.slice(2))
  .usage(`Usage: ${path.basename(process.argv0, '.exe')} . <command> [options]`)
  .command('patch', 'Patch HTTP Toolkit')
  .option('proxy', {
    alias: 'p',
    describe: 'Specify a global proxy (only http/https supported)',
    type: 'string'
  })
  .option('path', {
    alias: 'P',
    describe: 'Specify the path to the HTTP Toolkit folder (auto-detected by default)',
    type: 'string'
  })
  .command('restore', 'Restore HTTP Toolkit')
  .command('start', 'Start HTTP Toolkit with debug logs enabled')
  .demandCommand(1, 'You need at least one command before moving on')
  .alias('h', 'help')
  .describe('help', 'Show this help message')
  .parse()

const globalProxy = argv.proxy

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

//* why is there so many different paths, god damn
const getAppPath = () => {
  if (argv.path) return argv.path.match(/resources$/ig) ? argv.path : path.join(argv.path, isMac ? '/Resources' : '/resources')
  const paths = [
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'httptoolkit', 'resources'), //* Windows (per-user)
    path.join(process.env.ProgramFiles ?? '', 'HTTP Toolkit', 'resources'), //* Windows (Program Files)
    path.join(process.env['ProgramFiles(x86)'] ?? '', 'HTTP Toolkit', 'resources'), //* Windows (Program Files x86)
    '/Applications/HTTP Toolkit.app/Contents/Resources', //* macOS
    '/opt/HTTP Toolkit/resources', //* Linux
    '/opt/httptoolkit/resources', //* Arch Linux
    '/usr/lib/httptoolkit' //* Arch Linux (git)
  ]
  for (const p of paths) {
    if (fs.existsSync(p)) return p
  }
  return ''
}

const appPath = getAppPath()
const backupPath = path.join(os.tmpdir(), 'httptoolkit-patch-backup', 'app.asar.bak')

//* Resolve the main executable path (for ASAR fuse flipping) on each platform.
//* appPath points at the "resources" / "Resources" folder; the binary sits one level up.
const getExePath = () => {
  const resourcesDir = path.dirname(appPath) //* e.g. "C:\Program Files\HTTP Toolkit"
  if (isWin) return path.join(resourcesDir, 'HTTP Toolkit.exe')
  if (isMac) return path.join(resourcesDir, 'MacOS', 'httptoolkit')
  return path.join(resourcesDir, 'httptoolkit') //* Linux
}

const isSudo = !isWin && (process.getuid || (() => process.env.SUDO_UID ? 0 : null))() === 0

const permissionErrorText = isMac && isSudo ? 'please check known issues in the README' : `try running ${!isWin ? 'with sudo' : 'as administrator'}`

//* Read whether ASAR integrity validation is already disabled (fuse #0 === DISABLE/48).
const isAsarIntegrityDisabled = async (exePath) => {
  try {
    const wire = await getCurrentFuseWire(exePath)
    return wire[0] === 48
  } catch {
    return true // old Electron without a fuse wire — doesn't validate asar integrity
  }
}

//* Reliably disable ASAR integrity validation with retry + verification.
//* Throws on persistent failure so the caller surfaces a clear error instead of
//* leaving the app non-booting. Eliminates the need for a manual `fuses write` step.
const disableAsarIntegrity = async (exePath) => {
  if (await isAsarIntegrityDisabled(exePath)) {
    console.log(chalk.greenBright`[+] ASAR integrity validation already disabled`)
    return
  }
  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await flipFuses(exePath, {
        version: FuseVersion.V1,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false
      })
      lastErr = null
      break
    } catch (e) {
      lastErr = e
      if (e.code === 'EPERM') break // permissions won't improve with retry
      await new Promise(r => setTimeout(r, 500 * attempt))
    }
  }
  if (lastErr) {
    if (lastErr.code === 'EPERM') throw new Error(`Permission denied modifying ${exePath}, ${permissionErrorText}`)
    throw new Error(`Failed to disable ASAR integrity validation after retries: ${lastErr.message}`)
  }
  if (!(await isAsarIntegrityDisabled(exePath))) {
    throw new Error('ASAR integrity fuse did not switch off after flip. The exe may be re-signed or protected.')
  }
  console.log(chalk.greenBright`[+] Disabled ASAR integrity validation`)
}

if (+(process.versions.node.split('.')[0]) < 15) {
  console.error(chalk.redBright`[!] Node.js version 15 or higher is recommended, you are currently using version {bold ${process.versions.node}}`)
}

if (!fs.existsSync(path.join(appPath, 'app.asar'))) {
  console.error(chalk.redBright`[-] HTTP Toolkit not found${!argv.path ? ', try specifying the path with --path' : ''}`)
  process.exit(1)
}

console.log(chalk.blueBright`[+] HTTP Toolkit found at {bold ${appPath.match(/resources$/ig) ? path.dirname(appPath) : appPath}}`)

const rm = (/** @type {string} */ dirPath) => {
  if (!fs.existsSync(dirPath)) return
  if (!fs.lstatSync(dirPath).isDirectory()) return fs.rmSync(dirPath, { force: true })
  for (const entry of fs.readdirSync(dirPath)) {
    const entryPath = path.join(dirPath, entry)
    if (!fs.existsSync(entryPath)) continue
    if (fs.lstatSync(entryPath).isDirectory()) rm(entryPath)
    else fs.rmSync(entryPath, { force: true })
  }
}

const canWrite = (/** @type {string} */ dirPath) => {
  try {
    const testFile = path.join(dirPath, `.write-test-${Date.now()}`)
    fs.writeFileSync(testFile, '', 'utf-8')
    fs.rmSync(testFile, { force: true })
    return true
  } catch {
    return false
  }
}

/** @type {Array<import('child_process').ChildProcess>} */
const activeProcesses = []
let isCancelled = false
const cancelHandler = () => cleanUp(true)
const sigEvents = ['SIGINT', 'SIGTERM']
const registerSigHandlers = () => sigEvents.forEach(s => process.on(s, cancelHandler))
const unregisterSigHandlers = () => sigEvents.forEach(s => process.off(s, cancelHandler))

/** @param {boolean} cancel */
const cleanUp = async (cancel) => {
  if (cancel) {
    isCancelled = true
    console.log(chalk.redBright`[-] Operation cancelled, cleaning up...`)
  }
  if (activeProcesses.length) {
    console.log(chalk.yellowBright`[+] Killing active processes...`)
    for (const proc of activeProcesses) {
      proc.kill('SIGINT')
      console.log(chalk.yellowBright`[+] Process {bold ${proc.pid ? process.pid + ' ' : ''}}killed`)
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  const paths = [
    path.join(os.tmpdir(), 'httptoolkit-patch'),
    path.join(os.tmpdir(), 'httptoolkit-patcher-temp')
  ]
  try {
    for (const p of paths) {
      if (fs.existsSync(p)) {
        console.log(chalk.yellowBright`[+] Removing {bold ${p}}`)
        rm(p)
      }
    }
  } catch (e) {
    console.error(chalk.redBright`[-] An error occurred while cleaning up`, e)
  }
  if (cancel) process.exit(1)
}

const patchApp = async () => {
  const filePath = path.join(appPath, 'app.asar')
  const tempPath = path.join(os.tmpdir(), 'httptoolkit-patcher-temp')

  if (fs.readFileSync(filePath).includes('Injected by HTTP Toolkit Patcher')) {
    console.log(chalk.yellowBright`[!] HTTP Toolkit already patched`)
    try {
      await disableAsarIntegrity(getExePath())
    } catch (e) {
      console.error(chalk.redBright`[-] ${e.message}`)
    }
    return
  }

  console.log(chalk.blueBright`[+] Started patching app...`)

  if (!canWrite(path.dirname(filePath))) {
    console.error(chalk.redBright`[-] Insufficient permissions to write to {bold ${path.dirname(filePath)}}, ${permissionErrorText}`)
    process.exit(1)
  }

  if (globalProxy) {
    if (!globalProxy.match(/^https?:/)) {
      console.error(chalk.redBright`[-] Global proxy must start with http:// or https://`)
      process.exit(1)
    }
    console.log(chalk.yellowBright`[+] Adding a custom global proxy: {bold ${globalProxy}}`)
  }

  //? Disable ASAR integrity validation FIRST, before any asar write, with retry
  //? + verification. This keeps the app bootable even if a later step fails and
  //? removes the need for any manual `fuses write` command from the user.
  try {
    await disableAsarIntegrity(getExePath())
  } catch (e) {
    console.error(chalk.redBright`[-] ${e.message}`)
    process.exit(1)
  }

  console.log(chalk.yellowBright`[+] Extracting app...`)

  registerSigHandlers()

  try {
    rm(tempPath)
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { recursive: true })
    fs.mkdirSync(tempPath)
    asar.extractAll(filePath, tempPath)
  } catch (e) {
    if (!isSudo && e.errno === -13) { //? Permission denied
      console.error(chalk.redBright`[-] Permission denied, ${permissionErrorText}`)
      process.exit(1)
    }
    console.error(chalk.redBright`[-] An error occurred while extracting app`, e)
    process.exit(1)
  }

  const indexPath = path.join(tempPath, 'build', 'index.js')
  if (!fs.existsSync(indexPath)) {
    console.error(chalk.redBright`[-] Index file not found`)
    await cleanUp(true)
  }
  const data = fs.readFileSync(indexPath, 'utf-8')
  unregisterSigHandlers()
  //? Hardcoded random email - no prompt needed
  const email = `user${Math.random().toString(36).substring(2, 11)}@httptoolkit-pro.local`
  console.log(chalk.greenBright`[+] Using email: {bold ${email}}`)
  registerSigHandlers()
  const patch = fs.readFileSync('patch.js', 'utf-8')
  //? No need to clean patch anymore - we use unique variable names (patcherFs, patcherPath, patcherOs, patcherApp)
  const patchedData = data
    .replace('const APP_URL =', `// ------- Injected by HTTP Toolkit Patcher -------\nconst email = \`${email.replace(/`/g, '\\`')}\`\nconst globalProxy = process.env.PROXY ?? \`${globalProxy ? globalProxy.replace(/`/g, '\\`') : ''}\`\n${patch}\n// ------- End patched content -------\nconst APP_URL =`)

  if (data === patchedData || !patchedData) {
    console.error(chalk.redBright`[-] Patch failed`)
    await cleanUp(true)
  }

  fs.writeFileSync(indexPath, patchedData, 'utf-8')
  console.log(chalk.greenBright`[+] Patched index.js`)
  console.log(chalk.yellowBright`[+] Installing dependencies...`)
  try {
    const proc = spawn('npm install express axios got-scraping', { cwd: tempPath, stdio: 'inherit', shell: true })
    activeProcesses.push(proc)
    await new Promise(resolve =>
      proc.on('close', resolve)
    )
    activeProcesses.splice(activeProcesses.indexOf(proc), 1)
    if (isCancelled) return
  } catch (e) {
    console.error(chalk.redBright`[-] An error occurred while installing dependencies`, e)
    await cleanUp(true)
  }
  rm(path.join(tempPath, 'package-lock.json'))
  fs.mkdirSync(path.dirname(backupPath), { recursive: true })
  fs.copyFileSync(filePath, backupPath)
  console.log(chalk.greenBright`[+] Backup created at {bold ${backupPath}}`)
  console.log(chalk.yellowBright`[+] Building app...`)
  try {
    await Promise.race([
      asar.createPackage(tempPath, filePath),
      new Promise((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error('Timed out'), { code: 'ETIMEOUT' })), 60000)
      )
    ])
  } catch (e) {
    if (e.errno === -13 || e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'ETIMEOUT') {
      console.error(chalk.redBright`[-] Permission denied writing to {bold ${filePath}}, ${permissionErrorText}`)
      await cleanUp(true)
    }
    console.error(chalk.redBright`[-] An error occurred while building app`, e)
    await cleanUp(true)
  }
  rm(tempPath)

  //? ASAR integrity was disabled before any writes. Re-verify here in case an
  //? AV/EDR tool reverted the exe in the meantime; flip again if needed.
  try {
    if (!(await isAsarIntegrityDisabled(getExePath()))) {
      await disableAsarIntegrity(getExePath())
    }
  } catch (e) {
    console.error(chalk.redBright`[-] ${e.message}`)
  }

  unregisterSigHandlers()
  console.log(chalk.greenBright`[+] HTTP Toolkit patched successfully`)
  console.log(chalk.greenBright`[+] Restart HTTP Toolkit to apply changes`)
  await cleanUp(false)
}

switch (argv._[0]) {
  case 'patch':
    await patchApp()
    console.log(chalk.greenBright`[+] Done`)
    process.exit(0)
  case 'restore':
    try {
      console.log(chalk.blueBright`[+] Restoring HTTP Toolkit...`)
      if (!fs.existsSync(backupPath))
        console.error(chalk.redBright`[-] HTTP Toolkit not patched or backup file not found`)
      else {
        fs.copyFileSync(backupPath, path.join(appPath, 'app.asar'))
        console.log(chalk.greenBright`[+] HTTP Toolkit restored`)
      }
    } catch (e) {
      if (!isSudo && e.errno === -13) { //? Permission denied
        console.error(chalk.redBright`[-] Permission denied, ${permissionErrorText}`)
        process.exit(1)
      }
      console.error(chalk.redBright`[-] An error occurred`, e)
      process.exit(1)
    }
    console.log(chalk.greenBright`[+] Done`)
    process.exit(0)
  case 'start':
    console.log(chalk.blueBright`[+] Starting HTTP Toolkit...`)
    if (isSudo) console.warn(chalk.yellowBright`[!] Warning: Running with sudo may cause issues`)
    try {
      const command =
        isWin ? `"${path.resolve(appPath, '..', 'HTTP Toolkit.exe')}"`
        : isMac ? 'open -a "HTTP Toolkit"'
        : 'httptoolkit'
      //? Try to disable ASAR integrity check by setting environment variable
      const env = { ...process.env, ELECTRON_DISABLE_ASAR_INTEGRITY: '1' }
      const proc = spawn(command, { stdio: 'inherit', shell: true, env })
      proc.on('close', code => process.exit(code))
    } catch (e) {
      console.error(chalk.redBright`[-] An error occurred`, e)
      if (isSudo) console.error(chalk.redBright`[-] Try running without sudo`)
      process.exit(1)
    }
    break
  default:
    console.error(chalk.redBright`[-] Unknown command`)
    process.exit(1)
}
