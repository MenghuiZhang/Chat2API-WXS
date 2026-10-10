/**
 * Temp Mail Settings Dialog
 * Lets the user configure the Cloudflare Temp Email service used by the
 * Qwen AI auto-registration flow (API URL, admin password, mailbox domain).
 * Values are persisted in the app config (`tempMail`) and read by the
 * main process at registration time.
 */

import { useState, useEffect } from 'react'
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
import { useToast } from '@/hooks/use-toast'
import { Mail, Loader2, Eye, EyeOff, CheckCircle2, AlertCircle } from 'lucide-react'
import type { TempMailConfig } from '@/types/electron'

interface TempMailSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function TempMailSettingsDialog({ open, onOpenChange }: TempMailSettingsDialogProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [form, setForm] = useState<TempMailConfig>({ apiUrl: '', adminPassword: '', domain: '' })
  const [showPassword, setShowPassword] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)

  useEffect(() => {
    if (!open) return
    setTestResult(null)
    window.electronAPI?.tempMail
      ?.getConfig()
      .then((cfg) => setForm(cfg))
      .catch((error) => console.error('Failed to load temp mail config:', error))
  }, [open])

  const handleTest = async () => {
    setIsTesting(true)
    setTestResult(null)
    try {
      const result = await window.electronAPI.tempMail.test()
      if (result.success) {
        setTestResult({
          success: true,
          message: t('providers.tempMailTestSuccess', { address: result.address || '' }),
        })
      } else {
        setTestResult({
          success: false,
          message: t('providers.tempMailTestFailed', { error: result.error || t('common.error') }),
        })
      }
    } catch (error) {
      setTestResult({
        success: false,
        message: t('providers.tempMailTestFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      })
    } finally {
      setIsTesting(false)
    }
  }

  const handleSave = async () => {
    setIsSaving(true)
    try {
      await window.electronAPI.tempMail.updateConfig(form)
      toast({
        title: t('providers.tempMailSaved'),
      })
      onOpenChange(false)
    } catch (error) {
      toast({
        title: t('providers.tempMailSaveFailed'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            {t('providers.tempMailSettings')}
          </DialogTitle>
          <DialogDescription>{t('providers.tempMailSettingsDesc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label htmlFor="tempMailApiUrl">{t('providers.tempMailApiUrl')}</Label>
            <Input
              id="tempMailApiUrl"
              placeholder={t('providers.tempMailApiUrlPlaceholder')}
              value={form.apiUrl}
              onChange={(e) => setForm((prev) => ({ ...prev, apiUrl: e.target.value }))}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tempMailAdminPassword">{t('providers.tempMailAdminPassword')}</Label>
            <div className="relative">
              <Input
                id="tempMailAdminPassword"
                type={showPassword ? 'text' : 'password'}
                placeholder={t('providers.tempMailAdminPasswordPlaceholder')}
                value={form.adminPassword}
                onChange={(e) => setForm((prev) => ({ ...prev, adminPassword: e.target.value }))}
                className="pr-9"
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowPassword((v) => !v)}
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tempMailDomain">{t('providers.tempMailDomain')}</Label>
            <Input
              id="tempMailDomain"
              placeholder={t('providers.tempMailDomainPlaceholder')}
              value={form.domain}
              onChange={(e) => setForm((prev) => ({ ...prev, domain: e.target.value }))}
            />
          </div>

          <p className="text-xs text-muted-foreground">{t('providers.tempMailDefaultsHint')}</p>

          {testResult && (
            <div
              className={`flex items-center gap-2 text-sm p-3 rounded-lg ${
                testResult.success ? 'text-green-600 bg-green-50' : 'text-red-500 bg-red-50'
              }`}
            >
              {testResult.success ? (
                <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
              ) : (
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
              )}
              <span className="break-all">{testResult.message}</span>
            </div>
          )}
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={handleTest} disabled={isTesting || isSaving}>
            {isTesting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('providers.tempMailTesting')}
              </>
            ) : (
              t('providers.tempMailTest')
            )}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={isSaving || isTesting}>
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('common.loading')}
              </>
            ) : (
              t('common.save')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
