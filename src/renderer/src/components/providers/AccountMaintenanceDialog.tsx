/**
 * Account Maintenance Dialog
 * Settings for the batch / periodic account validation:
 *  - registration interval between two consecutive batch registrations
 *  - periodic automatic validation of all accounts (+ interval)
 *  - automatic deletion of accounts that fail validation
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ShieldCheck } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'

const MIN_INTERVAL_MINUTES = 5
const MAX_INTERVAL_MINUTES = 1440
const MIN_REGISTER_GAP_SECONDS = 0
const MAX_REGISTER_GAP_SECONDS = 300

interface AccountMaintenanceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AccountMaintenanceDialog({
  open,
  onOpenChange,
}: AccountMaintenanceDialogProps) {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [registerGap, setRegisterGap] = useState(10)
  const [autoCheck, setAutoCheck] = useState(false)
  const [intervalMinutes, setIntervalMinutes] = useState(30)
  const [autoDelete, setAutoDelete] = useState(false)
  const [autoRefill, setAutoRefill] = useState(false)
  const [targetCount, setTargetCount] = useState(0)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const load = async () => {
      try {
        const config = await window.electronAPI.config.get()
        if (cancelled) return
        setRegisterGap(
          Math.min(
            MAX_REGISTER_GAP_SECONDS,
            Math.max(MIN_REGISTER_GAP_SECONDS, config.registerIntervalSeconds ?? 10)
          )
        )
        setAutoCheck(config.autoCheckAccounts === true)
        setIntervalMinutes(
          Math.min(
            MAX_INTERVAL_MINUTES,
            Math.max(MIN_INTERVAL_MINUTES, config.autoCheckAccountsIntervalMinutes ?? 30)
          )
        )
        setAutoDelete(config.autoDeleteBadAccounts === true)
        setAutoRefill(config.autoRefillAccounts === true)
        setTargetCount(Math.min(999, Math.max(0, config.targetAccountCount ?? 0)))
      } catch (error) {
        console.error('Failed to load account maintenance config:', error)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [open])

  const handleSave = async () => {
    setSaving(true)
    try {
      const ok = await window.electronAPI.config.update({
        registerIntervalSeconds: Math.floor(registerGap),
        autoCheckAccounts: autoCheck,
        autoCheckAccountsIntervalMinutes: Math.floor(intervalMinutes),
        autoDeleteBadAccounts: autoDelete,
        autoRefillAccounts: autoRefill,
        targetAccountCount: Math.floor(targetCount),
      })
      if (ok) {
        toast({ title: t('providers.maintenanceSaved') })
        onOpenChange(false)
      } else {
        toast({
          title: t('providers.maintenanceSaveFailed'),
          variant: 'destructive',
        })
      }
    } catch (error) {
      toast({
        title: t('providers.maintenanceSaveFailed'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            {t('providers.accountMaintenance')}
          </DialogTitle>
          <DialogDescription>{t('providers.accountMaintenanceDesc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label htmlFor="registerGap">
              {t('providers.registerInterval')} ({MIN_REGISTER_GAP_SECONDS}-{MAX_REGISTER_GAP_SECONDS}s)
            </Label>
            <Input
              id="registerGap"
              type="number"
              min={MIN_REGISTER_GAP_SECONDS}
              max={MAX_REGISTER_GAP_SECONDS}
              value={registerGap}
              onChange={(e) =>
                setRegisterGap(
                  Math.min(
                    MAX_REGISTER_GAP_SECONDS,
                    Math.max(MIN_REGISTER_GAP_SECONDS, Math.floor(Number(e.target.value)) || 0)
                  )
                )
              }
            />
            <p className="text-xs text-muted-foreground">{t('providers.registerIntervalHint')}</p>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label>{t('providers.autoCheckAccounts')}</Label>
              <p className="text-xs text-muted-foreground">{t('providers.autoCheckAccountsHint')}</p>
            </div>
            <Switch checked={autoCheck} onCheckedChange={setAutoCheck} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="checkInterval">
              {t('providers.autoCheckInterval')} ({MIN_INTERVAL_MINUTES}-{MAX_INTERVAL_MINUTES})
            </Label>
            <Input
              id="checkInterval"
              type="number"
              min={MIN_INTERVAL_MINUTES}
              max={MAX_INTERVAL_MINUTES}
              value={intervalMinutes}
              disabled={!autoCheck}
              onChange={(e) =>
                setIntervalMinutes(
                  Math.min(
                    MAX_INTERVAL_MINUTES,
                    Math.max(MIN_INTERVAL_MINUTES, Math.floor(Number(e.target.value)) || MIN_INTERVAL_MINUTES)
                  )
                )
              }
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label>{t('providers.autoDeleteBadAccounts')}</Label>
              <p className="text-xs text-muted-foreground">{t('providers.autoDeleteBadAccountsHint')}</p>
            </div>
            <Switch checked={autoDelete} onCheckedChange={setAutoDelete} />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label>{t('providers.autoRefillAccounts')}</Label>
              <p className="text-xs text-muted-foreground">{t('providers.autoRefillAccountsHint')}</p>
            </div>
            <Switch
              checked={autoRefill}
              disabled={!autoDelete}
              onCheckedChange={setAutoRefill}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="targetCount">
              {t('providers.targetAccountCount')} (0-999)
            </Label>
            <Input
              id="targetCount"
              type="number"
              min={0}
              max={999}
              value={targetCount}
              onChange={(e) =>
                setTargetCount(
                  Math.min(999, Math.max(0, Math.floor(Number(e.target.value)) || 0))
                )
              }
            />
            <p className="text-xs text-muted-foreground">{t('providers.targetAccountCountHint')}</p>
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
