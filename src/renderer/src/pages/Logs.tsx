import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  RequestLogList,
  LogList,
  LogFilter,
  LogStats,
  LogDetailModal
} from '@/components/logs'
import { useLogsStore } from '@/stores/logsStore'
import type { LogEntry } from '@/types/electron'

export default function LogsPage() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const tabFromUrl = searchParams.get('tab')
  const [activeTab, setActiveTab] = useState<'request' | 'app'>(
    tabFromUrl === 'app' ? 'app' : 'request'
  )
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null)
  const refreshAppLogs = useLogsStore((state) => state.refresh)

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
          <LogStats showTrend={false} />
          <LogFilter />
          <LogList onLogClick={setSelectedLog} />
          <LogDetailModal
            log={selectedLog}
            open={!!selectedLog}
            onClose={() => setSelectedLog(null)}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
