// components/HealthPanel.tsx — 健身教练的身体档案、每日记录与趋势
import { useEffect, useMemo, useState } from 'react'
import type {
  FitnessLog,
  FitnessProfile,
  FitnessProfileInput,
  FitnessSummary,
} from '@shared/types'
import { api } from '../lib/api'
import { LineChartView } from './GenerativeCharts'
import { Field, btnGhostCls, btnPrimaryCls, inputCls } from './controls'
import { TrashIcon } from './icons'
import './generativeUi.css'

type Draft = Record<string, string>

function today(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`
}

function valueOrDash(value: number | null, suffix = ''): string {
  return value === null ? '—' : `${value}${suffix}`
}

function profileDraft(profile: FitnessProfile): Draft {
  const text = (value: number | null) => (value === null ? '' : String(value))
  return {
    age: text(profile.age),
    sex: profile.sex,
    height_cm: text(profile.height_cm),
    weight_kg: text(profile.weight_kg),
    body_fat_pct: text(profile.body_fat_pct),
    waist_cm: text(profile.waist_cm),
    goal: profile.goal,
    target_weight_kg: text(profile.target_weight_kg),
    target_date: profile.target_date,
    experience: profile.experience,
    injuries: profile.injuries,
    equipment: profile.equipment,
    plan: profile.plan,
    notes: profile.notes,
  }
}

function numberOrNull(value: string): number | null {
  const text = value.trim()
  if (!text) return null
  const number = Number(text)
  if (!Number.isFinite(number)) throw new Error('请输入有效数字')
  return number
}

function logDraft(log?: FitnessLog): Draft {
  const text = (value: number | null | undefined) =>
    value === null || value === undefined ? '' : String(value)
  return {
    date: log?.date ?? today(),
    weight_kg: text(log?.weight_kg),
    waist_cm: text(log?.waist_cm),
    body_fat_pct: text(log?.body_fat_pct),
    sleep_hours: text(log?.sleep_hours),
    steps: text(log?.steps),
    workout: log?.workout ?? '',
    protein_g: text(log?.protein_g),
    calories: text(log?.calories),
    note: log?.note ?? '',
  }
}

export function HealthPanel({ botId }: { botId: string }) {
  const [summary, setSummary] = useState<FitnessSummary | null>(null)
  const [profileText, setProfileText] = useState<Draft>({})
  const [logText, setLogText] = useState<Draft>(() => logDraft())
  const [profileDirty, setProfileDirty] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async (resetForms = false) => {
    try {
      const next = await api.getFitnessSummary(botId, 30)
      setSummary(next)
      if (resetForms || !profileDirty) setProfileText(profileDraft(next.profile))
    } catch (e) {
      setError(String(e))
    }
  }

  useEffect(() => {
    let active = true
    const run = async () => {
      try {
        const next = await api.getFitnessSummary(botId, 30)
        if (!active) return
        setSummary(next)
        setProfileText((current) =>
          Object.keys(current).length ? current : profileDraft(next.profile),
        )
      } catch (e) {
        if (active) setError(String(e))
      }
    }
    void run()
    const off = api.onEvent((event) => {
      if (event.type === 'fitness-updated' && event.botId === botId) {
        void api.getFitnessSummary(botId, 30).then((next) => {
          if (!active) return
          setSummary(next)
        })
      }
    })
    return () => {
      active = false
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId])

  useEffect(() => {
    if (!profileDirty && summary) setProfileText(profileDraft(summary.profile))
    // Only re-seed when the persisted profile changes; do not overwrite an active edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary?.profile.updated_at, profileDirty])

  const setProfile = (key: string, value: string) => {
    setProfileDirty(true)
    setProfileText((current) => ({ ...current, [key]: value }))
  }

  const saveProfile = async () => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const input: FitnessProfileInput = {
        bot_id: botId,
        age: numberOrNull(profileText.age ?? ''),
        sex: profileText.sex === '' ? '' : (profileText.sex as FitnessProfileInput['sex']),
        height_cm: numberOrNull(profileText.height_cm ?? ''),
        weight_kg: numberOrNull(profileText.weight_kg ?? ''),
        body_fat_pct: numberOrNull(profileText.body_fat_pct ?? ''),
        waist_cm: numberOrNull(profileText.waist_cm ?? ''),
        goal: profileText.goal ?? '',
        target_weight_kg: numberOrNull(profileText.target_weight_kg ?? ''),
        target_date: profileText.target_date ?? '',
        experience: profileText.experience ?? '',
        injuries: profileText.injuries ?? '',
        equipment: profileText.equipment ?? '',
        plan: profileText.plan ?? '',
        notes: profileText.notes ?? '',
      }
      const profile = await api.saveFitnessProfile(input)
      setProfileDirty(false)
      setProfileText(profileDraft(profile))
      await load(true)
      setMessage('身体档案已保存')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const saveLog = async () => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await api.saveFitnessLog({
        bot_id: botId,
        date: logText.date || today(),
        weight_kg: numberOrNull(logText.weight_kg ?? ''),
        waist_cm: numberOrNull(logText.waist_cm ?? ''),
        body_fat_pct: numberOrNull(logText.body_fat_pct ?? ''),
        sleep_hours: numberOrNull(logText.sleep_hours ?? ''),
        steps: numberOrNull(logText.steps ?? ''),
        workout: logText.workout ?? '',
        protein_g: numberOrNull(logText.protein_g ?? ''),
        calories: numberOrNull(logText.calories ?? ''),
        note: logText.note ?? '',
      })
      await load(true)
      setMessage('今日记录已保存')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const deleteLog = async (id: string) => {
    try {
      await api.deleteFitnessLog(id)
      await load(true)
      setMessage('记录已删除')
    } catch (e) {
      setError(String(e))
    }
  }

  const weightSeries = useMemo(() => summary?.series.weight ?? [], [summary])
  const profile = summary?.profile
  const latest = summary?.latest
  const averages = summary?.averages
  const change = summary?.change
  const recentLogs = (summary?.logs ?? []).slice(-8).reverse()

  return (
    <div className="space-y-4 px-4 py-4 text-[13px]">
      <section className="grid grid-cols-3 gap-2">
        <div className="rounded-xl border border-stone-200 bg-white/70 p-3 dark:border-stone-700 dark:bg-stone-800/60">
          <div className="text-[10px] text-stone-400">当前体重</div>
          <div className="mt-1 text-[18px] font-semibold tabular-nums">{valueOrDash(latest?.weight_kg ?? profile?.weight_kg ?? null, ' kg')}</div>
        </div>
        <div className="rounded-xl border border-stone-200 bg-white/70 p-3 dark:border-stone-700 dark:bg-stone-800/60">
          <div className="text-[10px] text-stone-400">7 日均值</div>
          <div className="mt-1 text-[18px] font-semibold tabular-nums">{valueOrDash(averages?.weight_kg ?? null, ' kg')}</div>
        </div>
        <div className="rounded-xl border border-stone-200 bg-white/70 p-3 dark:border-stone-700 dark:bg-stone-800/60">
          <div className="text-[10px] text-stone-400">30 天变化</div>
          <div className="mt-1 text-[18px] font-semibold tabular-nums">{valueOrDash(change?.weight_kg ?? null, ' kg')}</div>
        </div>
      </section>

      <section className="rounded-xl border border-stone-200 bg-white/70 p-3 dark:border-stone-700 dark:bg-stone-800/60">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[12px] font-medium text-stone-600 dark:text-stone-300">体重趋势 · 最近 30 天</span>
          <span className="text-[10px] text-stone-400">{weightSeries.length} 条</span>
        </div>
        {weightSeries.length >= 2 ? (
          <LineChartView
            title="体重"
            labels={weightSeries.map((point) => point.date.slice(5))}
            values={weightSeries.map((point) => point.value)}
          />
        ) : (
          <p className="py-6 text-center text-[12px] text-stone-400">记录至少两天的体重后，这里会出现趋势。</p>
        )}
      </section>

      {message && <p className="text-[12px] text-emerald-600 dark:text-emerald-400">{message}</p>}
      {error && <p role="alert" className="text-[12px] text-red-500">{error}</p>}

      <details className="rounded-xl border border-stone-200 bg-white/60 p-3 dark:border-stone-700 dark:bg-stone-800/50" open>
        <summary className="cursor-pointer text-[12px] font-medium text-stone-600 dark:text-stone-300">今日记录</summary>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Field label="日期"><input className={inputCls} type="date" value={logText.date ?? ''} onChange={(e) => setLogText({ ...logText, date: e.target.value })} /></Field>
          <Field label="体重 kg"><input className={inputCls} inputMode="decimal" value={logText.weight_kg ?? ''} onChange={(e) => setLogText({ ...logText, weight_kg: e.target.value })} /></Field>
          <Field label="腰围 cm"><input className={inputCls} inputMode="decimal" value={logText.waist_cm ?? ''} onChange={(e) => setLogText({ ...logText, waist_cm: e.target.value })} /></Field>
          <Field label="体脂 %"><input className={inputCls} inputMode="decimal" value={logText.body_fat_pct ?? ''} onChange={(e) => setLogText({ ...logText, body_fat_pct: e.target.value })} /></Field>
          <Field label="睡眠 h"><input className={inputCls} inputMode="decimal" value={logText.sleep_hours ?? ''} onChange={(e) => setLogText({ ...logText, sleep_hours: e.target.value })} /></Field>
          <Field label="步数"><input className={inputCls} inputMode="numeric" value={logText.steps ?? ''} onChange={(e) => setLogText({ ...logText, steps: e.target.value })} /></Field>
          <Field label="蛋白质 g"><input className={inputCls} inputMode="decimal" value={logText.protein_g ?? ''} onChange={(e) => setLogText({ ...logText, protein_g: e.target.value })} /></Field>
          <Field label="热量 kcal"><input className={inputCls} inputMode="decimal" value={logText.calories ?? ''} onChange={(e) => setLogText({ ...logText, calories: e.target.value })} /></Field>
        </div>
        <div className="mt-2">
          <Field label="训练"><input className={inputCls} placeholder="例如：上肢 A，卧推 3×8 @RIR2" value={logText.workout ?? ''} onChange={(e) => setLogText({ ...logText, workout: e.target.value })} /></Field>
        </div>
        <div className="mt-2">
          <Field label="备注"><textarea className={`${inputCls} min-h-[54px] resize-y`} value={logText.note ?? ''} onChange={(e) => setLogText({ ...logText, note: e.target.value })} /></Field>
        </div>
        <div className="mt-3 flex justify-end">
          <button className={btnPrimaryCls} disabled={busy} onClick={() => void saveLog()}>{busy ? '保存中…' : '保存今日记录'}</button>
        </div>
      </details>

      <details className="rounded-xl border border-stone-200 bg-white/60 p-3 dark:border-stone-700 dark:bg-stone-800/50">
        <summary className="cursor-pointer text-[12px] font-medium text-stone-600 dark:text-stone-300">身体档案与计划</summary>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Field label="年龄"><input className={inputCls} inputMode="numeric" value={profileText.age ?? ''} onChange={(e) => setProfile('age', e.target.value)} /></Field>
          <Field label="性别">
            <select className={inputCls} value={profileText.sex ?? ''} onChange={(e) => setProfile('sex', e.target.value)}>
              <option value="">未填写</option>
              <option value="female">女</option>
              <option value="male">男</option>
              <option value="other">其他</option>
            </select>
          </Field>
          <Field label="身高 cm"><input className={inputCls} inputMode="decimal" value={profileText.height_cm ?? ''} onChange={(e) => setProfile('height_cm', e.target.value)} /></Field>
          <Field label="体重 kg"><input className={inputCls} inputMode="decimal" value={profileText.weight_kg ?? ''} onChange={(e) => setProfile('weight_kg', e.target.value)} /></Field>
          <Field label="体脂 %"><input className={inputCls} inputMode="decimal" value={profileText.body_fat_pct ?? ''} onChange={(e) => setProfile('body_fat_pct', e.target.value)} /></Field>
          <Field label="腰围 cm"><input className={inputCls} inputMode="decimal" value={profileText.waist_cm ?? ''} onChange={(e) => setProfile('waist_cm', e.target.value)} /></Field>
          <Field label="目标体重 kg"><input className={inputCls} inputMode="decimal" value={profileText.target_weight_kg ?? ''} onChange={(e) => setProfile('target_weight_kg', e.target.value)} /></Field>
          <Field label="目标日期"><input className={inputCls} type="date" value={profileText.target_date ?? ''} onChange={(e) => setProfile('target_date', e.target.value)} /></Field>
        </div>
        <div className="mt-2">
          <Field label="目标"><input className={inputCls} placeholder="例如：薄肌、腰围 72cm、体脂 18%" value={profileText.goal ?? ''} onChange={(e) => setProfile('goal', e.target.value)} /></Field>
        </div>
        <div className="mt-2">
          <Field label="训练经验"><input className={inputCls} value={profileText.experience ?? ''} onChange={(e) => setProfile('experience', e.target.value)} /></Field>
        </div>
        <div className="mt-2">
          <Field label="伤病与限制"><input className={inputCls} value={profileText.injuries ?? ''} onChange={(e) => setProfile('injuries', e.target.value)} /></Field>
        </div>
        <div className="mt-2">
          <Field label="器械"><input className={inputCls} value={profileText.equipment ?? ''} onChange={(e) => setProfile('equipment', e.target.value)} /></Field>
        </div>
        <div className="mt-2">
          <Field label="计划"><textarea className={`${inputCls} min-h-[90px] resize-y`} value={profileText.plan ?? ''} onChange={(e) => setProfile('plan', e.target.value)} /></Field>
        </div>
        <div className="mt-2">
          <Field label="备注"><textarea className={`${inputCls} min-h-[54px] resize-y`} value={profileText.notes ?? ''} onChange={(e) => setProfile('notes', e.target.value)} /></Field>
        </div>
        <div className="mt-3 flex justify-end">
          <button className={btnPrimaryCls} disabled={busy} onClick={() => void saveProfile()}>{busy ? '保存中…' : '保存档案'}</button>
        </div>
      </details>

      <details className="rounded-xl border border-stone-200 bg-white/60 p-3 dark:border-stone-700 dark:bg-stone-800/50">
        <summary className="cursor-pointer text-[12px] font-medium text-stone-600 dark:text-stone-300">最近记录</summary>
        {recentLogs.length === 0 ? (
          <p className="py-4 text-center text-[12px] text-stone-400">还没有记录。</p>
        ) : (
          <div className="mt-2 divide-y divide-stone-200 dark:divide-stone-700">
            {recentLogs.map((log) => (
              <div key={log.id} className="flex items-center gap-2 py-2">
                <span className="w-[84px] shrink-0 text-[11px] tabular-nums text-stone-500">{log.date}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-stone-700 dark:text-stone-200">
                  {log.weight_kg !== null ? `${log.weight_kg} kg` : '—'}
                  {log.waist_cm !== null ? ` · 腰 ${log.waist_cm}` : ''}
                  {log.workout ? ` · ${log.workout}` : ''}
                </span>
                <button
                  className="icon-button shrink-0 text-stone-400 hover:text-red-500"
                  aria-label={`删除 ${log.date} 的记录`}
                  title="删除记录"
                  onClick={() => void deleteLog(log.id)}
                >
                  <TrashIcon width={13} height={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </details>

      <p className="text-[10.5px] leading-relaxed text-stone-400">
        健康数据保存在本机。Covan 不会自动读取 Apple 健康；需要从 iPhone 导出或手动记录。健身建议不构成医疗诊断。
      </p>
    </div>
  )
}
