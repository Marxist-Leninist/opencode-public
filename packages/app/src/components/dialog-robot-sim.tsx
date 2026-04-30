import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { createSignal, onCleanup, onMount, Show, createEffect } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import * as THREE from "three"
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js"

type Action = {
  shoulderDelta?: number
  elbowDelta?: number
  baseDelta?: number
  wristDelta?: number
  gripper?: "open" | "closed"
  reasoning?: string
  modality?: "vision" | "text"
  supportsImage?: boolean
}

type Joints = {
  base: number
  shoulder: number
  elbow: number
  wrist: number
  gripper: "open" | "closed"
}

const SCENE_W = 520
const SCENE_H = 360
const FPV_W = 320
const FPV_H = 240
const STORAGE_KEY = "opencode.robotSim.joints.v2"

const initial: Joints = {
  base: 0,
  shoulder: 35,
  elbow: -55,
  wrist: 10,
  gripper: "open",
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

function loadJoints(): Joints {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...initial }
    return { ...initial, ...JSON.parse(raw) }
  } catch {
    return { ...initial }
  }
}

function saveJoints(j: Joints) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(j))
  } catch {}
}

function describeScene(sim: Sim, joints: Joints) {
  const tip = sim.worldEnd()
  const target = sim.target.position.clone()
  sim.fpvCam.updateMatrixWorld(true)
  sim.fpvCam.updateProjectionMatrix()
  sim.target.updateMatrixWorld(true)

  const projected = target.clone().project(sim.fpvCam)
  const offsetX = clamp(projected.x * 50, -200, 200)
  const offsetY = clamp(-projected.y * 50, -200, 200)
  const distance = tip.distanceTo(target)
  const visible = projected.z >= -1 && projected.z <= 1 && Math.abs(projected.x) <= 1.25 && Math.abs(projected.y) <= 1.25
  const relative = target.clone().sub(tip)
  const horizontal = offsetX < -6 ? "left" : offsetX > 6 ? "right" : "centered"
  const vertical = offsetY < -6 ? "above" : offsetY > 6 ? "below" : "centered"

  return [
    `target_visible=${visible}`,
    `target_screen_offset_x_pct=${offsetX.toFixed(1)} (negative=left, positive=right, zero=centered)`,
    `target_screen_offset_y_pct=${offsetY.toFixed(1)} (negative=above, positive=below, zero=centered)`,
    `target_position_in_fpv=${horizontal}/${vertical}`,
    `distance_gripper_to_target_m=${distance.toFixed(3)}`,
    `relative_target_from_gripper_m: forward_x=${relative.x.toFixed(3)}, up_y=${relative.y.toFixed(3)}, lateral_z=${relative.z.toFixed(3)}`,
    `target_held=${sim.targetHeld}`,
    `current_joints_deg: base=${joints.base.toFixed(1)}, shoulder=${joints.shoulder.toFixed(1)}, elbow=${joints.elbow.toFixed(1)}, wrist=${joints.wrist.toFixed(1)}, gripper=${joints.gripper}`,
    "safety: return only small deltas; close gripper only when distance is below 0.22m",
  ].join("\n")
}

type Sim = {
  scene: THREE.Scene
  godCam: THREE.PerspectiveCamera
  fpvCam: THREE.PerspectiveCamera
  godRenderer: THREE.WebGLRenderer
  fpvRenderer: THREE.WebGLRenderer
  joints: {
    base: THREE.Group
    shoulder: THREE.Group
    elbow: THREE.Group
    wrist: THREE.Group
    fingerL: THREE.Mesh
    fingerR: THREE.Mesh
    end: THREE.Object3D
  }
  target: THREE.Mesh
  targetHeld: boolean
  apply(j: Joints): void
  worldEnd(): THREE.Vector3
  capture(): { fpv: string; god: string }
  dispose(): void
}

function buildSim(godCanvas: HTMLCanvasElement, fpvCanvas: HTMLCanvasElement): Sim {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x18222e)

  // Renderers: high-quality PBR + ACES tonemapping
  const mkRenderer = (canvas: HTMLCanvasElement, w: number, h: number) => {
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" })
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    r.setSize(w, h, false)
    r.outputColorSpace = THREE.SRGBColorSpace
    r.toneMapping = THREE.ACESFilmicToneMapping
    r.toneMappingExposure = 1.0
    r.shadowMap.enabled = true
    r.shadowMap.type = THREE.PCFSoftShadowMap
    return r
  }
  const godRenderer = mkRenderer(godCanvas, SCENE_W, SCENE_H)
  const fpvRenderer = mkRenderer(fpvCanvas, FPV_W, FPV_H)

  // Procedural studio-style environment for PBR reflections
  const pmrem = new THREE.PMREMGenerator(godRenderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture

  // Lights
  const hemi = new THREE.HemisphereLight(0xffffff, 0x202533, 0.45)
  scene.add(hemi)
  const dir = new THREE.DirectionalLight(0xfff2d6, 1.4)
  dir.position.set(3, 6, 2)
  dir.castShadow = true
  dir.shadow.mapSize.set(1024, 1024)
  dir.shadow.camera.near = 0.5
  dir.shadow.camera.far = 20
  dir.shadow.camera.left = -5
  dir.shadow.camera.right = 5
  dir.shadow.camera.top = 5
  dir.shadow.camera.bottom = -5
  dir.shadow.bias = -0.0005
  scene.add(dir)
  const fill = new THREE.DirectionalLight(0x8aa9ff, 0.35)
  fill.position.set(-4, 3, -2)
  scene.add(fill)

  // Floor
  const floorGeo = new THREE.PlaneGeometry(20, 20)
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x2a3038,
    metalness: 0.15,
    roughness: 0.55,
  })
  const floor = new THREE.Mesh(floorGeo, floorMat)
  floor.rotation.x = -Math.PI / 2
  floor.receiveShadow = true
  scene.add(floor)

  // Floor grid for sense of scale (subtle)
  const grid = new THREE.GridHelper(10, 20, 0x3a4250, 0x252a30)
  ;(grid.material as THREE.Material).transparent = true
  ;(grid.material as THREE.Material).opacity = 0.35
  grid.position.y = 0.001
  scene.add(grid)

  // Robot base plate
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x3a4350, metalness: 0.6, roughness: 0.35 })
  const basePlate = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.5, 0.12, 32), baseMat)
  basePlate.position.set(0, 0.06, 0)
  basePlate.castShadow = true
  basePlate.receiveShadow = true
  scene.add(basePlate)

  // Joint hierarchy: base -> shoulder -> upperArm -> elbow -> forearm -> wrist -> gripper
  const baseGroup = new THREE.Group()
  baseGroup.position.y = 0.12
  scene.add(baseGroup)

  const baseColumn = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.45, 24), baseMat)
  baseColumn.position.y = 0.225
  baseColumn.castShadow = true
  baseGroup.add(baseColumn)

  const shoulderGroup = new THREE.Group()
  shoulderGroup.position.y = 0.45
  baseGroup.add(shoulderGroup)

  const armMat = new THREE.MeshStandardMaterial({ color: 0xc9d1d9, metalness: 0.75, roughness: 0.3 })
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xff7a3d, metalness: 0.4, roughness: 0.45 })

  const shoulderHub = new THREE.Mesh(new THREE.SphereGeometry(0.12, 24, 16), trimMat)
  shoulderHub.castShadow = true
  shoulderGroup.add(shoulderHub)

  const upperArm = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.9, 20), armMat)
  upperArm.castShadow = true
  upperArm.position.x = 0.45
  upperArm.rotation.z = -Math.PI / 2
  shoulderGroup.add(upperArm)

  const elbowGroup = new THREE.Group()
  elbowGroup.position.x = 0.9
  shoulderGroup.add(elbowGroup)

  const elbowHub = new THREE.Mesh(new THREE.SphereGeometry(0.09, 24, 16), trimMat)
  elbowHub.castShadow = true
  elbowGroup.add(elbowHub)

  const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.75, 20), armMat)
  forearm.castShadow = true
  forearm.position.x = 0.375
  forearm.rotation.z = -Math.PI / 2
  elbowGroup.add(forearm)

  const wristGroup = new THREE.Group()
  wristGroup.position.x = 0.75
  elbowGroup.add(wristGroup)

  const wristHub = new THREE.Mesh(new THREE.SphereGeometry(0.07, 20, 14), trimMat)
  wristHub.castShadow = true
  wristGroup.add(wristHub)

  // Gripper palm
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.18), armMat)
  palm.position.x = 0.09
  palm.castShadow = true
  wristGroup.add(palm)

  // Gripper fingers
  const fingerMat = new THREE.MeshStandardMaterial({ color: 0x222a33, metalness: 0.2, roughness: 0.7 })
  const fingerGeo = new THREE.BoxGeometry(0.18, 0.04, 0.06)
  const fingerL = new THREE.Mesh(fingerGeo, fingerMat)
  const fingerR = new THREE.Mesh(fingerGeo, fingerMat)
  fingerL.castShadow = true
  fingerR.castShadow = true
  fingerL.position.set(0.21, 0, 0.07)
  fingerR.position.set(0.21, 0, -0.07)
  wristGroup.add(fingerL)
  wristGroup.add(fingerR)

  // End-effector marker (invisible, just a pose anchor)
  const end = new THREE.Object3D()
  end.position.set(0.32, 0, 0)
  wristGroup.add(end)

  // Target cube: glossy painted wood
  const targetMat = new THREE.MeshStandardMaterial({
    color: 0x4ade80,
    metalness: 0.1,
    roughness: 0.25,
  })
  const target = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), targetMat)
  target.castShadow = true
  target.receiveShadow = true
  target.position.set(1.2, 0.08, 0.4)
  scene.add(target)

  // Backdrop accent: a low platform under target for visual interest
  const accent = new THREE.Mesh(
    new THREE.BoxGeometry(2.2, 0.02, 1.4),
    new THREE.MeshStandardMaterial({ color: 0x1c252e, metalness: 0.3, roughness: 0.6 }),
  )
  accent.position.set(1.0, 0.01, 0.2)
  accent.receiveShadow = true
  scene.add(accent)

  // Cameras
  const godCam = new THREE.PerspectiveCamera(45, SCENE_W / SCENE_H, 0.05, 50)
  godCam.position.set(2.6, 1.9, 2.4)
  godCam.lookAt(0.6, 0.5, 0)

  const fpvCam = new THREE.PerspectiveCamera(70, FPV_W / FPV_H, 0.02, 20)
  // Mount FPV camera on the wrist hub looking forward (+x in wrist frame)
  wristGroup.add(fpvCam)
  fpvCam.position.set(0.05, 0.06, 0)
  fpvCam.lookAt(new THREE.Vector3(1, 0, 0).add(fpvCam.position))

  let targetHeld = false

  return {
    scene,
    godCam,
    fpvCam,
    godRenderer,
    fpvRenderer,
    joints: { base: baseGroup, shoulder: shoulderGroup, elbow: elbowGroup, wrist: wristGroup, fingerL, fingerR, end },
    target,
    targetHeld,
    apply(j: Joints) {
      baseGroup.rotation.y = THREE.MathUtils.degToRad(j.base)
      shoulderGroup.rotation.z = THREE.MathUtils.degToRad(j.shoulder)
      elbowGroup.rotation.z = THREE.MathUtils.degToRad(j.elbow)
      wristGroup.rotation.z = THREE.MathUtils.degToRad(j.wrist)
      const open = j.gripper === "open"
      fingerL.position.z = open ? 0.07 : 0.025
      fingerR.position.z = open ? -0.07 : -0.025
    },
    worldEnd() {
      const v = new THREE.Vector3()
      end.getWorldPosition(v)
      return v
    },
    capture() {
      godRenderer.render(scene, godCam)
      fpvRenderer.render(scene, fpvCam)
      return {
        god: godCanvas.toDataURL("image/png"),
        fpv: fpvCanvas.toDataURL("image/png"),
      }
    },
    dispose() {
      godRenderer.dispose()
      fpvRenderer.dispose()
      pmrem.dispose()
      scene.traverse((obj) => {
        if ((obj as any).geometry) (obj as any).geometry.dispose?.()
        const mat = (obj as any).material
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.())
        else mat?.dispose?.()
      })
    },
  }
}

export function DialogRobotSim() {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const server = useServer()
  const platform = usePlatform()

  const [joints, setJoints] = createSignal<Joints>(loadJoints())
  const [goal, setGoal] = createSignal("Pick up the green cube on the right.")
  const [auto, setAuto] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [log, setLog] = createSignal<string[]>([])

  let godCanvas!: HTMLCanvasElement
  let fpvCanvas!: HTMLCanvasElement
  let sim: Sim | null = null
  let frame: number | null = null

  const appendLog = (line: string) => setLog((prev) => [line, ...prev].slice(0, 60))

  const apply = (delta: Action) => {
    setJoints((prev) => {
      const next: Joints = {
        base: clamp(prev.base + (delta.baseDelta ?? 0), -180, 180),
        shoulder: clamp(prev.shoulder + (delta.shoulderDelta ?? 0), -10, 90),
        elbow: clamp(prev.elbow + (delta.elbowDelta ?? 0), -120, 30),
        wrist: clamp(prev.wrist + (delta.wristDelta ?? 0), -90, 90),
        gripper: delta.gripper ?? prev.gripper,
      }
      saveJoints(next)
      return next
    })
    if (delta.reasoning) appendLog(`[ai] ${delta.reasoning}`)
  }

  createEffect(() => {
    const j = joints()
    if (sim) sim.apply(j)
  })

  // Pick / drop logic: simple distance-based
  createEffect(() => {
    const j = joints()
    if (!sim) return
    const tip = sim.worldEnd()
    const tgt = sim.target.position
    const d = tip.distanceTo(tgt)
    if (j.gripper === "closed" && d < 0.2 && !sim.targetHeld) {
      sim.targetHeld = true
      appendLog(`[sim] grasped (d=${d.toFixed(3)})`)
    }
    if (j.gripper === "open" && sim.targetHeld) {
      sim.targetHeld = false
      sim.target.position.set(tip.x, Math.max(0.08, tip.y), tip.z)
      appendLog("[sim] released")
    }
    if (sim.targetHeld) {
      sim.target.position.copy(tip)
    }
  })

  const headers = (json = false) => {
    const h: Record<string, string> = { accept: "application/json" }
    if (json) h["content-type"] = "application/json"
    const http = server.current?.http
    if (http?.password) h.authorization = `Basic ${btoa(`${http.username ?? "opencode"}:${http.password}`)}`
    return h
  }

  const stepWithAi = async () => {
    if (!sim || busy()) return
    setBusy(true)
    try {
      const { fpv, god } = sim.capture()
      const fetcher = platform.fetch ?? fetch
      const res = await fetcher(`${globalSDK.url}/robot/step`, {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify({
          goal: goal(),
          fpv,
          scene: god,
          sceneDescription: describeScene(sim, joints()),
          joints: joints(),
          targetHeld: sim.targetHeld,
        }),
      })
      if (!res.ok) {
        const t = await res.text().catch(() => "")
        throw new Error(t || `HTTP ${res.status}`)
      }
      const action = (await res.json()) as Action
      apply(action)
      const tag = action.modality === "vision" ? "ai/vision" : action.modality === "text" ? "ai/text" : "ai"
      appendLog(
        `[${tag}] b${(action.baseDelta ?? 0).toFixed(0)} s${(action.shoulderDelta ?? 0).toFixed(0)} e${(action.elbowDelta ?? 0).toFixed(0)} w${(action.wristDelta ?? 0).toFixed(0)} g=${action.gripper ?? joints().gripper}`,
      )
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause)
      appendLog(`[err] ${msg}`)
      // Heuristic fallback so the loop is testable without backend wiring
      if (sim) {
        const tip = sim.worldEnd()
        const tgt = sim.target.position
        const dx = tgt.x - tip.x
        const dy = tgt.y - tip.y
        const dz = tgt.z - tip.z
        const yaw = Math.atan2(dz, dx)
        const baseDelta = clamp(THREE.MathUtils.radToDeg(yaw), -8, 8)
        apply({
          baseDelta: -baseDelta,
          shoulderDelta: clamp(-dy * 30, -5, 5),
          elbowDelta: clamp(-Math.hypot(dx, dz) * 5 + 6, -5, 5),
          gripper: tip.distanceTo(tgt) < 0.22 ? "closed" : joints().gripper,
          reasoning: "fallback heuristic (backend /robot/step missing)",
        })
      }
    } finally {
      setBusy(false)
    }
  }

  createEffect(() => {
    if (!auto()) return
    let cancelled = false
    const loop = async () => {
      while (!cancelled && auto()) {
        await stepWithAi()
        await new Promise((r) => setTimeout(r, 600))
      }
    }
    void loop()
    onCleanup(() => {
      cancelled = true
    })
  })

  onMount(() => {
    sim = buildSim(godCanvas, fpvCanvas)
    sim.apply(joints())
    const tick = () => {
      if (!sim) return
      sim.godRenderer.render(sim.scene, sim.godCam)
      sim.fpvRenderer.render(sim.scene, sim.fpvCam)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
  })

  onCleanup(() => {
    if (frame !== null) cancelAnimationFrame(frame)
    sim?.dispose()
    sim = null
  })

  const reset = () => {
    setJoints({ ...initial })
    if (sim) {
      sim.targetHeld = false
      sim.target.position.set(1.2, 0.08, 0.4)
    }
    setLog([])
    appendLog("[sim] reset")
  }

  return (
    <Dialog
      title="Robot sim - 3D PBR (experimental)"
      description="Three.js + ACES tonemapping. FPV vision input feeds /robot/step."
    >
      <div class="flex flex-col gap-3 min-w-[880px]">
        <div class="flex gap-3">
          <div class="flex flex-col gap-2">
            <span class="text-11-regular text-text-weak">God-eye</span>
            <canvas
              ref={godCanvas!}
              width={SCENE_W}
              height={SCENE_H}
              class="rounded border border-border-base"
            />
          </div>
          <div class="flex flex-col gap-2 flex-1 min-w-0">
            <span class="text-11-regular text-text-weak">FPV (vision input)</span>
            <canvas
              ref={fpvCanvas!}
              width={FPV_W}
              height={FPV_H}
              class="rounded border border-border-base"
            />
            <div class="flex flex-col gap-1.5">
              <label class="text-12-regular text-text-base">Goal prompt</label>
              <TextField
                value={goal()}
                onChange={(v) => setGoal(v)}
                onInput={(e) => setGoal((e.currentTarget as HTMLInputElement).value)}
                placeholder="Pick up the green cube on the right."
              />
            </div>
            <div class="flex gap-2">
              <Button size="small" onClick={stepWithAi} disabled={busy()}>
                {busy() ? "Stepping..." : "Step (AI)"}
              </Button>
              <Button
                size="small"
                variant={auto() ? "primary" : "secondary"}
                onClick={() => setAuto((v) => !v)}
              >
                {auto() ? "Stop auto" : "Auto"}
              </Button>
              <Button size="small" variant="secondary" onClick={reset}>
                Reset
              </Button>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-4 gap-3">
          <div class="flex flex-col gap-1">
            <label class="text-11-regular text-text-weak">Base yaw {joints().base.toFixed(0)} deg</label>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={joints().base}
              onInput={(e) => setJoints((j) => ({ ...j, base: Number((e.currentTarget as HTMLInputElement).value) }))}
            />
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-11-regular text-text-weak">Shoulder {joints().shoulder.toFixed(0)} deg</label>
            <input
              type="range"
              min={-10}
              max={90}
              step={1}
              value={joints().shoulder}
              onInput={(e) => setJoints((j) => ({ ...j, shoulder: Number((e.currentTarget as HTMLInputElement).value) }))}
            />
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-11-regular text-text-weak">Elbow {joints().elbow.toFixed(0)} deg</label>
            <input
              type="range"
              min={-120}
              max={30}
              step={1}
              value={joints().elbow}
              onInput={(e) => setJoints((j) => ({ ...j, elbow: Number((e.currentTarget as HTMLInputElement).value) }))}
            />
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-11-regular text-text-weak">Wrist {joints().wrist.toFixed(0)} deg</label>
            <input
              type="range"
              min={-90}
              max={90}
              step={1}
              value={joints().wrist}
              onInput={(e) => setJoints((j) => ({ ...j, wrist: Number((e.currentTarget as HTMLInputElement).value) }))}
            />
          </div>
        </div>

        <div class="flex items-center gap-3">
          <Button
            size="small"
            variant="secondary"
            onClick={() => setJoints((j) => ({ ...j, gripper: j.gripper === "open" ? "closed" : "open" }))}
          >
            Gripper: {joints().gripper}
          </Button>
        </div>

        <Show when={log().length > 0}>
          <div class="rounded border border-border-base bg-surface-base p-2 max-h-[140px] overflow-y-auto font-mono text-11-regular text-text-base">
            {log().map((line) => (
              <div>{line}</div>
            ))}
          </div>
        </Show>

        <div class="flex justify-end pt-2 border-t border-border-base">
          <Button variant="secondary" onClick={() => dialog.close()}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
