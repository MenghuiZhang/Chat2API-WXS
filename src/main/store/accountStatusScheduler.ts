/**
 * Account Status Auto-Refresh Scheduler
 *
 * Two complementary jobs:
 *  1. Abnormal re-check: accounts whose status is not 'active' are
 *     re-validated every minute until they recover.
 *  2. Periodic full check (user-configurable): when `autoCheckAccounts` is
 *     enabled in settings, ALL accounts are validated every
 *     `autoCheckAccountsIntervalMinutes` minutes. When validation fails,
 *     built-in providers (e.g. Qwen AI) attempt a forced re-authentication
 *     via stored refresh credentials before marking the account as error.
 *     Accounts that still fail are deleted when `autoDeleteBadAccounts`
 *     is enabled; otherwise they are only marked as error. Failures caused
 *     by transient network problems (DNS failure, timeout, offline) are
 *     NEVER treated as bad accounts and never trigger deletion.
 *  3. Target account count (user-configurable): when `targetAccountCount`
 *     is > 0, every provider whose account count is below the target gets a
 *     refill request sent to the renderer (which runs the auto-registration
 *     flow). Checked at startup and after every periodic full check.
 */

import { IpcChannels } from '../ipc/channels'
import { getMainWindow } from '../window/manager'
import { AccountManager } from './accounts'
import { storeManager } from './store'
import type { Account } from './types'

/** Re-check interval for abnormal accounts: 1 minute */
const CHECK_INTERVAL_MS = 60_000

/** Bounds for the user-configured periodic check interval */
const MIN_PERIODIC_INTERVAL_MINUTES = 5
const MAX_PERIODIC_INTERVAL_MINUTES = 1440

let timer: ReturnType<typeof setInterval> | null = null
let checking = false

/**
 * Notify the renderer that an account status has changed,
 * so the UI can update without a manual refresh.
 * Credentials are stripped before sending.
 */
function notifyRenderer(account: Account): void {
  const win = getMainWindow()

  if (!win || win.isDestroyed()) {
    return
  }

  win.webContents.send(IpcChannels.ACCOUNTS_STATUS_CHANGED, {
    ...account,
    credentials: {},
  })
}

/**
 * Notify the renderer that an account was removed by the scheduler,
 * so the list can drop it without a manual refresh.
 */
function notifyRendererRemoved(account: Account): void {
  const win = getMainWindow()

  if (!win || win.isDestroyed()) {
    return
  }

  win.webContents.send(IpcChannels.ACCOUNTS_REMOVED, {
    id: account.id,
    providerId: account.providerId,
    name: account.name,
  })
}

/**
 * Re-validate all accounts whose status is not 'active'.
 * Runs sequentially and skips overlapping invocations.
 */
async function runAbnormalCheck(): Promise<void> {
  if (checking) {
    // Previous check is still in progress; skip this tick.
    return
  }

  checking = true

  try {
    const accounts = AccountManager.getAll(true)
    const abnormal = accounts.filter((account) => account.status !== 'active')

    if (abnormal.length === 0) {
      return
    }

    storeManager.addLog(
      'info',
      `Auto re-checking ${abnormal.length} account(s) with abnormal status`
    )

    for (const account of abnormal) {
      // The account may have been deleted while waiting.
      if (!AccountManager.getById(account.id)) {
        continue
      }

      try {
        const result = await AccountManager.validate(account.id)

        const updated = AccountManager.getById(account.id)

        if (updated) {
          notifyRenderer(updated)
        }

        if (result.valid) {
          storeManager.addLog(
            'info',
            `Account "${account.name}" recovered automatically (status → active)`
          )
        } else {
          storeManager.addLog(
            'debug',
            `Account "${account.name}" is still abnormal: ${result.error || 'Unknown error'}`
          )
        }
      } catch (error) {
        storeManager.addLog(
          'warn',
          `Failed to re-check account "${account.name}": ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }
  } finally {
    checking = false
  }
}

/**
 * Validate every account once (periodic / manual full check). Accounts
 * that fail with credential errors are deleted when autoDeleteBadAccounts
 * is enabled, otherwise marked as error. Accounts that fail only because
 * of network problems are always kept untouched. Progress is streamed to
 * the renderer.
 */
export async function runFullCheck(): Promise<{
  total: number
  valid: number
  deleted: number
}> {
  if (checking) {
    return { total: 0, valid: 0, deleted: 0 }
  }

  checking = true

  const win = () => {
    const w = getMainWindow()
    return w && !w.isDestroyed() ? w : null
  }

  const sendProgress = (current: number, total: number, name: string): void => {
    win()?.webContents.send(IpcChannels.ACCOUNTS_BATCH_VALIDATE_PROGRESS, {
      current,
      total,
      name,
    })
  }

  try {
    const config = storeManager.getConfig()
    const autoDelete = config.autoDeleteBadAccounts === true

    const accounts = AccountManager.getAll(true)
    const total = accounts.length
    let validCount = 0
    let deletedCount = 0
    /** Deleted accounts per provider, used for the auto-refill request. */
    const deletedByProvider = new Map<string, number>()

    storeManager.addLog('info', `Full account check started for ${total} account(s)`)

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i]

      // The account may have been deleted while waiting.
      if (!AccountManager.getById(account.id)) {
        continue
      }

      sendProgress(i + 1, total, account.name)

      try {
        const result = await AccountManager.validate(account.id)

        if (result.valid) {
          validCount++
          const updated = AccountManager.getById(account.id)
          if (updated) {
            notifyRenderer(updated)
          }
        } else if (result.networkError) {
          // Transient connectivity problem (DNS failure, timeout, offline).
          // Never delete or count these as bad accounts — the credentials
          // were not proven invalid. The abnormal re-check job will retry.
          storeManager.addLog(
            'warn',
            `Skipped account "${account.name}" during full check: network error (${result.error || 'Unknown error'}) — account kept`
          )
        } else if (autoDelete) {
          const removed = AccountManager.delete(account.id)
          if (removed) {
            deletedCount++
            deletedByProvider.set(
              account.providerId,
              (deletedByProvider.get(account.providerId) ?? 0) + 1
            )
            storeManager.addLog(
              'warn',
              `Account "${account.name}" failed validation and was auto-deleted: ${result.error || 'Unknown error'}`
            )
            notifyRendererRemoved(account)
            continue
          }
        } else {
          const updated = AccountManager.getById(account.id)
          if (updated) {
            notifyRenderer(updated)
          }
          storeManager.addLog(
            'warn',
            `Account "${account.name}" failed validation: ${result.error || 'Unknown error'}`
          )
        }
      } catch (error) {
        storeManager.addLog(
          'warn',
          `Failed to check account "${account.name}": ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }

    storeManager.addLog(
      'info',
      `Full account check finished: ${validCount}/${total} valid, ${deletedCount} deleted`
    )

    // Ask the renderer to register replacement accounts for the deleted ones.
    // Registration opens a visible in-app window and is driven by the renderer
    // (temp-mail flow), so the request is forwarded instead of running here.
    if (config.autoRefillAccounts === true && deletedCount > 0) {
      sendRefillRequests(
        Array.from(deletedByProvider.entries()).map(([providerId, count]) => ({
          providerId,
          count,
        })),
        `Auto-refill requested for ${deletedCount} deleted account(s)`
      )
    }

    return { total, valid: validCount, deleted: deletedCount }
  } finally {
    checking = false
  }
}

/**
 * Forward refill requests to the renderer, which drives the actual
 * registration (visible in-app window + temp-mail flow).
 */
function sendRefillRequests(
  requests: { providerId: string; count: number }[],
  logMessage: string
): void {
  if (requests.length === 0) return

  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(IpcChannels.ACCOUNTS_REFILL_NEEDED, requests)
    storeManager.addLog('info', `${logMessage}: ${JSON.stringify(requests)}`)
  } else {
    storeManager.addLog(
      'warn',
      'Auto-refill skipped: main window is not available to run the registration flow'
    )
  }
}

/**
 * Compare each provider's account count against the configured target
 * (`targetAccountCount`, 0 = disabled) and request the renderer to register
 * the missing accounts. Runs at startup, after every periodic full check,
 * and immediately when the target is changed in settings.
 */
export function requestRefillToTarget(): void {
  const config = storeManager.getConfig()
  const target = Math.floor(config.targetAccountCount ?? 0)
  if (!(target > 0)) return

  const providers = storeManager.getProviders()
  const requests: { providerId: string; count: number }[] = []

  for (const provider of providers) {
    const current = AccountManager.getByProviderId(provider.id).length
    if (current < target) {
      requests.push({ providerId: provider.id, count: target - current })
    }
  }

  sendRefillRequests(
    requests,
    `Account count below target (${target}); refill requested`
  )
}

function periodicIntervalMs(): number {
  const config = storeManager.getConfig()
  const minutes = config.autoCheckAccountsIntervalMinutes ?? 30
  const clamped = Math.min(
    MAX_PERIODIC_INTERVAL_MINUTES,
    Math.max(MIN_PERIODIC_INTERVAL_MINUTES, Math.floor(minutes) || 30)
  )
  return clamped * 60_000
}

function schedulePeriodicCheck(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }

  const config = storeManager.getConfig()
  if (config.autoCheckAccounts !== true) {
    return
  }

  const intervalMs = periodicIntervalMs()
  timer = setInterval(() => {
    void runFullCheck().then(() => {
      requestRefillToTarget()
    })
  }, intervalMs)

  // Don't keep the process alive just for this timer.
  if (typeof timer.unref === 'function') {
    timer.unref()
  }

  console.log(
    `[AccountStatusScheduler] Periodic full check enabled: every ${Math.round(intervalMs / 60000)} minute(s)`
  )
}

/**
 * Start the scheduler. Safe to call multiple times.
 * Also performs an immediate first abnormal-status check so accounts
 * persisted with an abnormal status are re-validated right after startup.
 */
export function startAccountStatusScheduler(): void {
  schedulePeriodicCheck()

  console.log(
    '[AccountStatusScheduler] Started: abnormal account statuses are re-checked every 60 seconds'
  )

  // Immediate first check (covers statuses persisted from the previous session).
  void runAbnormalCheck()

  // Bring every provider up to the configured target account count.
  // Delayed so the renderer has finished loading its initial account list.
  setTimeout(() => requestRefillToTarget(), 5_000).unref?.()
}

/**
 * Re-apply the periodic schedule after config changes
 * (autoCheckAccounts / autoCheckAccountsIntervalMinutes).
 */
export function applyAccountCheckConfig(): void {
  schedulePeriodicCheck()
}

/**
 * Stop the scheduler.
 */
export function stopAccountStatusScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
    console.log('[AccountStatusScheduler] Stopped')
  }
}

/**
 * Trigger an immediate re-check of abnormal accounts
 * (does not wait for the next scheduled tick).
 */
export function triggerAccountStatusCheck(): void {
  void runCheck()
}
