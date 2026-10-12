/**
 * Network & Captcha settings tab.
 *
 * Card 1: Geepass captcha-recognition service (token / enable / test).
 * Card 2: Upstream proxy — manual proxy URL or automatic local Clash client
 *         detection, optionally driven by a Clash subscription link (the
 *         subscription nodes are listed read-only; only a local Clash
 *         mixed-port or a manual http/socks5 URL can actually be dialed).
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { ShieldCheck, Globe2, Loader2, Eye, EyeOff, CheckCircle2, AlertCircle, Radio, ListTree } from 'lucide-react'
import type { GeepassConfig, UpstreamProxyConfig, ClashProxyNode } from '@/types/electron'

export function NetworkCaptchaSettings() {
  const { t } = useTranslation()
  const { toast } = useToast()

  // ===== Geepass =====
  const [gp, setGp] = useState<GeepassConfig>({ enabled: false, token: '', type: 20110 })
  const [gpShowToken, setGpShowToken] = useState(false)
  const [gpTesting, setGpTesting] = useState(false)
  const [gpSaving, setGpSaving] = useState(false)
  const [gpResult, setGpResult] = useState<{ success: boolean; message: string } | null>(null)

  // ===== Upstream proxy =====
  const [up, setUp] = useState<UpstreamProxyConfig>({ enabled: false, source: 'clash' })
  const [upTesting, setUpTesting] = useState(false)
  const [upSaving, setUpSaving] = useState(false)
  const [upResult, setUpResult] = useState<{ success: boolean; message: string } | null>(null)
  const [parsing, setParsing] = useState(false)
  const [nodes, setNodes] = useState<ClashProxyNode[] | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)

  useEffect(() => {
    window.electronAPI?.geepass
      ?.getConfig()
      .then((cfg) => setGp(cfg))
      .catch((e) => console.error('Failed to load geepass config:', e))
    window.electronAPI?.upstreamProxy
      ?.getConfig()
      .then((cfg) => setUp(cfg))
      .catch((e) => console.error('Failed to load upstream proxy config:', e))
  }, [])

  const handleGpSave = useCallback(async () => {
    setGpSaving(true)
    try {
      const merged = await window.electronAPI.geepass.updateConfig(gp)
      setGp(merged)
      toast({ title: t('settings.network.geepassSaved') })
    } catch (e) {
      toast({
        title: t('settings.network.geepassSaveFailed'),
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      })
    } finally {
      setGpSaving(false)
    }
  }, [gp, t, toast])

  const handleGpTest = useCallback(async () => {
    setGpTesting(true)
    setGpResult(null)
    try {
      // Persist the token first so the test uses what the user typed.
      await window.electronAPI.geepass.updateConfig(gp)
      const r = await window.electronAPI.geepass.test()
      setGpResult({ success: r.success, message: r.message })
    } catch (e) {
      setGpResult({ success: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setGpTesting(false)
    }
  }, [gp])

  const handleUpSave = useCallback(async () => {
    setUpSaving(true)
    try {
      const merged = await window.electronAPI.upstreamProxy.updateConfig(up)
      setUp(merged)
      toast({ title: t('settings.network.proxySaved') })
    } catch (e) {
      toast({
        title: t('settings.network.proxySaveFailed'),
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      })
    } finally {
      setUpSaving(false)
    }
  }, [up, t, toast])

  const handleUpTest = useCallback(async () => {
    setUpTesting(true)
    setUpResult(null)
    try {
      // Persist current form first.
      await window.electronAPI.upstreamProxy.updateConfig(up)
      const r = await window.electronAPI.upstreamProxy.test()
      setUpResult({
        success: r.active,
        message: r.active ? `${r.url} (${r.source})` : r.message || t('settings.network.proxyTestFailed'),
      })
    } catch (e) {
      setUpResult({ success: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setUpTesting(false)
    }
  }, [up, t])

  const handleParseSubscription = useCallback(async () => {
    setParsing(true)
    setNodes(null)
    setParseError(null)
    try {
      const r = await window.electronAPI.upstreamProxy.parseSubscription(up.subscriptionUrl)
      if (r.error) setParseError(r.error)
      setNodes(r.nodes || [])
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e))
    } finally {
      setParsing(false)
    }
  }, [up.subscriptionUrl])

  return (
    <div className="space-y-6">
      {/* ===== Geepass card ===== */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            {t('settings.network.geepassTitle')}
          </CardTitle>
          <CardDescription>{t('settings.network.geepassDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="geepass-enabled">{t('settings.network.geepassEnabled')}</Label>
              <p className="text-sm text-muted-foreground">{t('settings.network.geepassEnabledHelp')}</p>
            </div>
            <Switch
              id="geepass-enabled"
              checked={gp.enabled}
              onCheckedChange={(v) => setGp((p) => ({ ...p, enabled: v }))}
            />
          </div>
          <Separator />
          <div className="space-y-2">
            <Label htmlFor="geepass-token">{t('settings.network.geepassToken')}</Label>
            <div className="relative">
              <Input
                id="geepass-token"
                type={gpShowToken ? 'text' : 'password'}
                placeholder={t('settings.network.geepassTokenPlaceholder')}
                value={gp.token}
                onChange={(e) => setGp((p) => ({ ...p, token: e.target.value }))}
                className="pr-10"
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setGpShowToken((v) => !v)}
                tabIndex={-1}
              >
                {gpShowToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div className="space-y-2">
            <Label>{t('settings.network.geepassType')}</Label>
            <Select
              value={String(gp.type)}
              onValueChange={(v) => setGp((p) => ({ ...p, type: Number(v) as 20110 | 20111 }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="20110">{t('settings.network.geepassType20110')}</SelectItem>
                <SelectItem value="20111">{t('settings.network.geepassType20111')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {gpResult && (
            <div
              className={`flex items-center gap-2 text-sm ${gpResult.success ? 'text-green-600' : 'text-destructive'}`}
            >
              {gpResult.success ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
              <span>{gpResult.message}</span>
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleGpTest} disabled={gpTesting || !gp.token.trim()}>
              {gpTesting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              {t('settings.network.test')}
            </Button>
            <Button onClick={handleGpSave} disabled={gpSaving}>
              {gpSaving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              {t('common.save')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('settings.network.geepassCompliance')}</p>
        </CardContent>
      </Card>

      {/* ===== Upstream proxy card ===== */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Globe2 className="h-5 w-5" />
            {t('settings.network.proxyTitle')}
          </CardTitle>
          <CardDescription>{t('settings.network.proxyDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="upstream-enabled">{t('settings.network.proxyEnabled')}</Label>
              <p className="text-sm text-muted-foreground">{t('settings.network.proxyEnabledHelp')}</p>
            </div>
            <Switch
              id="upstream-enabled"
              checked={up.enabled}
              onCheckedChange={(v) => setUp((p) => ({ ...p, enabled: v }))}
            />
          </div>
          <Separator />
          <div className="space-y-2">
            <Label>{t('settings.network.proxySource')}</Label>
            <Select
              value={up.source}
              onValueChange={(v) => setUp((p) => ({ ...p, source: v as 'manual' | 'clash' | 'embedded' }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="clash">{t('settings.network.proxySourceClash')}</SelectItem>
                <SelectItem value="embedded">{t('settings.network.proxySourceEmbedded')}</SelectItem>
                <SelectItem value="manual">{t('settings.network.proxySourceManual')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {up.source === 'manual' ? (
            <div className="space-y-2">
              <Label htmlFor="upstream-manual">{t('settings.network.proxyManualUrl')}</Label>
              <Input
                id="upstream-manual"
                placeholder="http://127.0.0.1:7890"
                value={up.manualUrl || ''}
                onChange={(e) => setUp((p) => ({ ...p, manualUrl: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">{t('settings.network.proxyManualHelp')}</p>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="upstream-sub">{t('settings.network.proxySubscriptionUrl')}</Label>
                <div className="flex gap-2">
                  <Input
                    id="upstream-sub"
                    placeholder="https://example.com/sub/xxxx"
                    value={up.subscriptionUrl || ''}
                    onChange={(e) => setUp((p) => ({ ...p, subscriptionUrl: e.target.value }))}
                  />
                  <Button
                    variant="outline"
                    onClick={handleParseSubscription}
                    disabled={parsing || !up.subscriptionUrl?.trim()}
                  >
                    {parsing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListTree className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t('settings.network.proxySubscriptionHelp')}</p>
              </div>
              {up.source === 'clash' && (
                <div className="space-y-2">
                  <Label htmlFor="upstream-port">{t('settings.network.proxyMixedPort')}</Label>
                  <Input
                    id="upstream-port"
                    type="number"
                    min={1}
                    max={65535}
                    placeholder={t('settings.network.proxyMixedPortPlaceholder')}
                    value={up.mixedPort ?? ''}
                    onChange={(e) =>
                      setUp((p) => ({ ...p, mixedPort: e.target.value ? Number(e.target.value) : undefined }))
                    }
                  />
                </div>
              )}
              {parseError && (
                <div className="flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  <span>{parseError}</span>
                </div>
              )}
              {nodes && (
                <div className="rounded-md border p-3 space-y-1 max-h-48 overflow-y-auto">
                  <div className="flex items-center gap-2 text-sm font-medium mb-1">
                    <Radio className="h-4 w-4" />
                    {t('settings.network.proxyNodesFound', { count: nodes.length })}
                  </div>
                  {nodes.length === 0 && (
                    <p className="text-xs text-muted-foreground">{t('settings.network.proxyNoNodes')}</p>
                  )}
                  {nodes.map((n) => (
                    <div key={n.name} className="flex items-center justify-between text-xs gap-2">
                      <span className="truncate">{n.name}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {n.type} · {n.server}:{n.port}
                        {!n.usable && ` · ${t('settings.network.proxyNodeLocalOnly')}`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {(nodes && nodes.length > 0 ? true : !!up.selectedNode) && (
                <div className="space-y-2">
                  <Label>{t('settings.network.proxyNodeSelect')}</Label>
                  <Select
                    value={up.selectedNode ? up.selectedNode : '__auto__'}
                    onValueChange={(v) =>
                      setUp((p) => ({ ...p, selectedNode: v === '__auto__' ? '' : v }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__auto__">{t('settings.network.proxyNodeAuto')}</SelectItem>
                      {(nodes && nodes.length
                        ? nodes
                        : up.selectedNode
                          ? [{ name: up.selectedNode, type: '', server: '', port: 0, usable: false }]
                          : []
                      ).map((n) => (
                        <SelectItem key={n.name} value={n.name}>
                          {n.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{t('settings.network.proxyNodeSelectHelp')}</p>
                </div>
              )}
            </>
          )}

          {upResult && (
            <div
              className={`flex items-center gap-2 text-sm ${upResult.success ? 'text-green-600' : 'text-destructive'}`}
            >
              {upResult.success ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
              <span>{upResult.message}</span>
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleUpTest} disabled={upTesting}>
              {upTesting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              {t('settings.network.test')}
            </Button>
            <Button onClick={handleUpSave} disabled={upSaving}>
              {upSaving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              {t('common.save')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
