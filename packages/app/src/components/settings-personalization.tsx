import type { Config } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, createMemo, type Component, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { SettingsList } from "./settings-list"

// Structured preference tags. Each is a single line in config.preferences,
// e.g. "[sg.personality] pragmatic". Anything that does not match these tags
// is treated as free-text custom instructions and rendered into the textarea.
const PERSONALITY_TAG = "[sg.personality]"
const CALL_ME_TAG = "[sg.callMe]"
const WORK_TAG = "[sg.work]"

type PersonalityValue = "balanced" | "pragmatic" | "warmer" | "concise" | "formal" | "creative"

type PersonalityOption = { value: PersonalityValue; label: string; phrase: string | null }

const PERSONALITY_OPTIONS: PersonalityOption[] = [
  { value: "balanced", label: "Balanced", phrase: null },
  { value: "pragmatic", label: "Pragmatic", phrase: "Be pragmatic, plain-spoken, and decisive." },
  { value: "warmer", label: "Warmer", phrase: "Be a bit warmer and more personable; sprinkle in encouragement." },
  { value: "concise", label: "Concise", phrase: "Default to short answers; cut fluff and only expand when asked." },
  { value: "formal", label: "Formal", phrase: "Use a more formal, professional register." },
  { value: "creative", label: "Creative", phrase: "Lean playful and inventive when the task allows." },
]

const PERSONALITY_VALUES = new Set<PersonalityValue>(PERSONALITY_OPTIONS.map((o) => o.value))

type PreferencesConfig = Config & {
  preferences?: string | string[]
}

function withPreferences(config: Config) {
  return config as PreferencesConfig
}

function preferencesArray(preferences: PreferencesConfig["preferences"]): string[] {
  if (!preferences) return []
  if (Array.isArray(preferences)) return preferences.map((s) => s.trim()).filter(Boolean)
  return preferences
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean)
}

type Parsed = {
  personality: PersonalityValue
  callMe: string
  work: string
  customText: string
}

function parsePreferences(preferences: PreferencesConfig["preferences"]): Parsed {
  const out: Parsed = { personality: "balanced", callMe: "", work: "", customText: "" }
  const customs: string[] = []
  for (const item of preferencesArray(preferences)) {
    if (item.startsWith(PERSONALITY_TAG)) {
      const v = item.slice(PERSONALITY_TAG.length).trim() as PersonalityValue
      if (PERSONALITY_VALUES.has(v)) out.personality = v
      continue
    }
    if (item.startsWith(CALL_ME_TAG)) {
      out.callMe = item.slice(CALL_ME_TAG.length).trim()
      continue
    }
    if (item.startsWith(WORK_TAG)) {
      out.work = item.slice(WORK_TAG.length).trim()
      continue
    }
    // Suppress the auto-generated companion lines so they don't appear twice.
    if (
      item.startsWith("Call me ") ||
      item.startsWith("What I work on:") ||
      PERSONALITY_OPTIONS.some((o) => o.phrase && o.phrase === item)
    ) {
      continue
    }
    customs.push(item)
  }
  out.customText = customs.join("\n\n")
  return out
}

function buildPreferences(p: Parsed): string[] {
  const list: string[] = []
  if (p.personality !== "balanced") {
    list.push(`${PERSONALITY_TAG} ${p.personality}`)
    const opt = PERSONALITY_OPTIONS.find((o) => o.value === p.personality)
    if (opt?.phrase) list.push(opt.phrase)
  }
  const callMe = p.callMe.trim()
  if (callMe) {
    list.push(`${CALL_ME_TAG} ${callMe}`)
    list.push(`Call me ${callMe}.`)
  }
  const work = p.work.trim()
  if (work) {
    list.push(`${WORK_TAG} ${work}`)
    list.push(`What I work on: ${work}`)
  }
  for (const item of p.customText.split(/\n{2,}/)) {
    const trimmed = item.trim()
    if (trimmed) list.push(trimmed)
  }
  return list
}

function sameParsed(a: Parsed, b: Parsed) {
  return (
    a.personality === b.personality &&
    a.callMe.trim() === b.callMe.trim() &&
    a.work.trim() === b.work.trim() &&
    a.customText.trim() === b.customText.trim()
  )
}

export const SettingsPersonalization: Component = () => {
  const language = useLanguage()
  const globalSync = useGlobalSync()
  const fromConfig = createMemo<Parsed>(() =>
    parsePreferences(withPreferences(globalSync.data.config).preferences),
  )

  const [state, setState] = createStore<{
    personality: PersonalityValue
    callMe: string
    work: string
    customText: string
    loaded: Parsed
    saving: boolean
  }>({
    personality: "balanced",
    callMe: "",
    work: "",
    customText: "",
    loaded: { personality: "balanced", callMe: "", work: "", customText: "" },
    saving: false,
  })

  const current = (): Parsed => ({
    personality: state.personality,
    callMe: state.callMe,
    work: state.work,
    customText: state.customText,
  })
  const dirty = createMemo(() => !sameParsed(current(), state.loaded))
  const itemCount = createMemo(() => buildPreferences(current()).length)

  // Hydrate from config whenever it changes and the user is not mid-edit.
  createEffect(() => {
    const next = fromConfig()
    if (state.saving) return
    if (sameParsed(next, state.loaded)) return
    if (sameParsed(current(), state.loaded)) {
      setState({
        personality: next.personality,
        callMe: next.callMe,
        work: next.work,
        customText: next.customText,
        loaded: next,
      })
    } else {
      setState("loaded", next)
    }
  })

  const reset = () => {
    const next = fromConfig()
    setState({
      personality: next.personality,
      callMe: next.callMe,
      work: next.work,
      customText: next.customText,
      loaded: next,
    })
  }

  const save = async () => {
    setState("saving", true)
    try {
      const built = current()
      const preferences = buildPreferences(built)
      await globalSync.updateConfig({ preferences } as PreferencesConfig)
      setState("loaded", built)
      showToast({ variant: "success", icon: "circle-check", title: "Personalization saved" })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: message })
    } finally {
      setState("saving", false)
    }
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-2 pt-6 pb-8 max-w-[760px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.personalization.title")}</h2>
          <p class="text-13-regular text-text-weak">{language.t("settings.personalization.description")}</p>
          <Show when={globalSync.data.path.config}>
            <TextField
              label="Config path"
              hideLabel
              readOnly
              copyable
              value={globalSync.data.path.config}
              class="text-12-regular"
            />
          </Show>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[760px]">
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">
            {language.t("settings.personalization.section.identity")}
          </h3>
          <SettingsList>
            <div class="flex flex-col gap-4 py-4">
              <div class="flex flex-col gap-2">
                <label class="text-13-medium text-text-strong">
                  {language.t("settings.personalization.field.personality")}
                </label>
                <p class="text-12-regular text-text-weak">
                  {language.t("settings.personalization.field.personality.description")}
                </p>
                <Select
                  data-action="settings-personality"
                  options={PERSONALITY_OPTIONS}
                  current={PERSONALITY_OPTIONS.find((o) => o.value === state.personality) ?? PERSONALITY_OPTIONS[0]}
                  value={(o) => o.value}
                  label={(o) => o.label}
                  onSelect={(option) => option && setState("personality", option.value)}
                  variant="secondary"
                  size="small"
                  triggerVariant="settings"
                />
              </div>
              <TextField
                label={language.t("settings.personalization.field.callMe")}
                description={language.t("settings.personalization.field.callMe.description")}
                value={state.callMe}
                onChange={(v) => setState("callMe", v)}
                placeholder={language.t("settings.personalization.field.callMe.placeholder")}
                spellcheck={true}
              />
              <TextField
                label={language.t("settings.personalization.field.work")}
                description={language.t("settings.personalization.field.work.description")}
                value={state.work}
                onChange={(v) => setState("work", v)}
                placeholder={language.t("settings.personalization.field.work.placeholder")}
                spellcheck={true}
              />
            </div>
          </SettingsList>
        </div>

        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">
            {language.t("settings.personalization.section.instructions")}
          </h3>
          <SettingsList>
            <div class="flex flex-col gap-3 py-4">
              <TextField
                label={language.t("settings.personalization.field.instructions")}
                description={language.t("settings.personalization.field.instructions.description")}
                multiline
                value={state.customText}
                onChange={(v) => setState("customText", v)}
                placeholder={language.t("settings.personalization.field.instructions.placeholder")}
                spellcheck={true}
                class="min-h-[260px] resize-y text-12-regular leading-5"
              />
              <div class="flex flex-wrap items-center justify-between gap-3">
                <span class="text-12-regular text-text-weak">
                  {language.t("settings.personalization.status", { count: itemCount() })}
                </span>
                <div class="flex items-center gap-2">
                  <Button
                    type="button"
                    size="small"
                    variant="ghost"
                    disabled={state.saving || !dirty()}
                    onClick={reset}
                  >
                    {language.t("settings.personalization.action.reset")}
                  </Button>
                  <Button type="button" size="small" disabled={state.saving || !dirty()} onClick={() => void save()}>
                    {state.saving
                      ? language.t("common.saving")
                      : language.t("settings.personalization.action.save")}
                  </Button>
                </div>
              </div>
            </div>
          </SettingsList>
        </div>
      </div>
    </div>
  )
}
