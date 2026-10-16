import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Download } from 'lucide-react'
import {
  RequestLogList,
  LogList,
  LogFilter,
  LogStats,
  LogDetail
} from '@/components/logs'
import { useLogsStore } from '@/stores/logsStore'
import { useToast } from '@/hooks/use-toast'

export default function LogsPage() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const tabFromUrl = searchParams.get('tab')
  const [activeTab, setActiveTab] = useState<'request' | 'app'>(
    tabFromUrl === 'app' ? 'app' : 'request'
  )
  const [isExporting, setIsExporting] = useState(false)
  const refreshAppLogs = useLogsStore((state) => state.refresh)
  const setSelectedLog = useLogsStore((state) => state.setSelectedLog)

  useEffect(() => {
    if (tabFromUrl === 'app') {
      setActiveTab('app')
    }
  }, [tabFromUrl])

  useEffect(() => {
    if (activeTab !== 'app') return undefined
    refreshAppLogs()
    const interval = setInterval(() => {
      refreshAppLogs().catch((error) => {
        console.error('Failed to refresh app logs:', error)
      })
    }, 3000)
    return () => clearInterval(interval)
  }, [activeTab, refreshAppLogs])

  const handleTabChange = (value: string): void => {
    setActiveTab(value === 'app' ? 'app' : 'request')
    setSearchParams(value === 'app' ? { tab: 'app' } : {}, { replace: true })
  }

  const handleExportLogs = async (): Promise<void> => {
    if (!window.electronAPI?.logs?.export) {
      toast({
        title: t('logs.exportFailed'),
        description: t('logs.exportNotAvailable'),
        variant: 'destructive',
      })
      return
    }

    setIsExporting(true)
    try {
      const filePath = await window.electronAPI.logs.export('json')
      toast({
        title: t('logs.exportSuccess'),
        description: t('logs.exportedTo', { path: filePath }),
      })
    } catch (error) {
      console.error('Export logs failed:', error)
      toast({
        title: t('logs.exportFailed'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('logs.title')}</h1>
          <p className="text-muted-foreground">{t('logs.description')}</p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-4">
        <TabsList>
          <TabsTrigger value="request">{t('logs.requestLogs')}</TabsTrigger>
          <TabsTrigger value="app">{t('logs.appLogs')}</TabsTrigger>
        </TabsList>

        <TabsContent value="request">
          <RequestLogList />
        </TabsContent>

        <TabsContent value="app" className="space-y-4">
          <div className="flex items-center justify-between">
            <LogStats showTrend={false} />
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportLogs}
              disabled={isExporting}
            >
              <Download className="h-4 w-4 mr-2" />
              {isExporting ? t('logs.exporting') : t('logs.exportAll')}
            </Button>
          </div>
          <LogFilter />
          <LogList onLogClick={setSelectedLog} />
          <LogDetail />
        </TabsContent>
      </Tabs>
    </div>
  )
}
