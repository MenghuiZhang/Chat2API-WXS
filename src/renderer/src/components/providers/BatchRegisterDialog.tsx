/**
 * Batch Register Dialog
 * Lets the user choose how many Qwen AI accounts to register in one run.
 * Registrations execute sequentially (one in-app registration window at a
 * time); every successful account is added to the list automatically.
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
import { Users, Square } from 'lucide-react'

/** Upper safety bound only; users may register arbitrarily many accounts. */
const MAX_BATCH = 999
const QUICK_COUNTS = [1, 3, 5, 10, 20, 50]

interface BatchRegisterDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  isRegistering: boolean
  registerStatus: string
  doneCount: number
  totalCount: number
  onStart: (count: number) => void
  onStop: () => void
}

export function BatchRegisterDialog({
  open,
  onOpenChange,
  isRegistering,
  registerStatus,
  doneCount,
  totalCount,
  onStart,
  onStop,
}: BatchRegisterDialogProps) {
  const { t } = useTranslation()
  const [count, setCount] = useState(3)

  useEffect(() => {
    if (open && !isRegistering) setCount(3)
  }, [open, isRegistering])

  const clamp = (value: number): number =>
    Math.min(MAX_BATCH, Math.max(1, Math.floor(value) || 1))

  const progressPercent =
    totalCount > 0 ? Math.round((Math.min(doneCount, totalCount) / totalCount) * 100) : 0

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Keep the dialog open while a batch is running so the user can stop it.
        if (!isRegistering) onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            {t('providers.batchRegister')}
          </DialogTitle>
          <DialogDescription>{t('providers.batchRegisterDesc')}</DialogDescription>
        </DialogHeader>

        {isRegistering ? (
          <div className="space-y-3 mt-2">
            <div className="text-sm font-medium">
              {t('providers.batchDone', { done: doneCount, total: totalCount })}
            </div>
            <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-green-600 transition-all"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            {registerStatus && (
              <p className="text-xs text-muted-foreground break-all">{registerStatus}</p>
            )}
          </div>
        ) : (
          <div className="space-y-3 mt-2">
            <div className="space-y-2">
              <Label htmlFor="batchCount">
                {t('providers.batchCount')} (1-{MAX_BATCH})
              </Label>
              <Input
                id="batchCount"
                type="number"
                min={1}
                max={MAX_BATCH}
                value={count}
                onChange={(e) => setCount(clamp(Number(e.target.value)))}
              />
            </div>
            <div className="flex gap-2">
              {QUICK_COUNTS.map((n) => (
                <Button
                  key={n}
                  size="sm"
                  variant={count === n ? 'default' : 'outline'}
                  onClick={() => setCount(n)}
                >
                  {n}
                </Button>
              ))}
            </div>
          </div>
        )}

        <DialogFooter className="mt-4">
          {isRegistering ? (
            <Button variant="destructive" onClick={onStop}>
              <Square className="mr-2 h-4 w-4" />
              {t('providers.batchStop')}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => onStart(count)} disabled={count < 1}>
                <Users className="mr-2 h-4 w-4" />
                {t('providers.batchStart')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
