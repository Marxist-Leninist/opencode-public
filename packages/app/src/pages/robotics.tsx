import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/tag"
import { batch, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLocal } from "@/context/local"
import { useModels } from "@/context/models"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import * as THREE from "three"
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"

type TransportKind = "simulator" | "hardware"
type ControllerKind = "agi-vision"

type RobotPose = {
  x: number
  y: number
  z: number
  yaw: number
  grip: number
}

type TargetPose = {
  x: number
  y: number
  z: number
}

type RobotCommand = {
  x: number
  y: number
  z: number
  yaw: number
  grip: number
  label: string
}

type VisionFrame = {
  targetX: number
  targetY: number
  offsetX: number
  offsetY: number
  depth: number
  confidence: number
}

type RobotAction = {
  baseDelta?: number
  shoulderDelta?: number
  elbowDelta?: number
  wristDelta?: number
  gripper?: "open" | "closed"
  reasoning?: string
  modality?: "vision" | "text"
  supportsImage?: boolean
}

const DEFAULT_POSE: RobotPose = { x: 0, y: 42, z: 28, yaw: 0, grip: 42 }
const DEFAULT_TARGET: TargetPose = { x: 22, y: 64, z: 36 }
const ZERO_COMMAND: RobotCommand = { x: 0, y: 0, z: 0, yaw: 0, grip: 0, label: "awaiting image" }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const distance = (pose: RobotPose, target: TargetPose) =>
  Math.hypot(target.x - pose.x, target.y - pose.y, target.z - pose.z)

function observeImage(pose: RobotPose, target: TargetPose): VisionFrame {
  const dx = target.x - pose.x
  const dy = target.y - pose.y
  const dz = target.z - pose.z
  const targetX = clamp(50 + dx * 0.75 - pose.yaw * 0.3, 7, 93)
  const targetY = clamp(50 - dz * 0.9 + dy * 0.12, 10, 86)
  const depth = clamp(Math.hypot(dx, dy, dz), 0, 120)
  return {
    targetX,
    targetY,
    offsetX: targetX - 50,
    offsetY: targetY - 50,
    depth,
    confidence: clamp(1 - depth / 140, 0.18, 0.98),
  }
}

function imageServoCommand(frame: VisionFrame, pose: RobotPose, target: TargetPose): RobotCommand {
  const dx = target.x - pose.x
  const dy = target.y - pose.y
  const dz = target.z - pose.z
  const near = Math.hypot(dx, dy, dz) < 5
  return {
    x: clamp(dx * 0.1, -2.8, 2.8),
    y: clamp(dy * 0.09, -2.8, 2.8),
    z: clamp(dz * 0.1, -2.2, 2.2),
    yaw: clamp(-frame.offsetX * 0.04, -1.4, 1.4),
    grip: near ? 2.4 : -0.5,
    label: near ? "close gripper" : "vision policy",
  }
}

function applyCommand(pose: RobotPose, command: RobotCommand): RobotPose {
  return {
    x: clamp(pose.x + command.x, -48, 48),
    y: clamp(pose.y + command.y, 14, 92),
    z: clamp(pose.z + command.z, 8, 64),
    yaw: clamp(pose.yaw + command.yaw, -55, 55),
    grip: clamp(pose.grip + command.grip, 0, 100),
  }
}

function makeConcreteTexture() {
  const canvas = document.createElement("canvas")
  canvas.width = 512
  canvas.height = 512
  const ctx = canvas.getContext("2d")
  if (!ctx) return undefined

  ctx.fillStyle = "#555b58"
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  for (let i = 0; i < 9000; i++) {
    const v = 74 + Math.random() * 42
    ctx.fillStyle = `rgba(${v}, ${v + 4}, ${v + 2}, ${Math.random() * 0.18})`
    ctx.fillRect(Math.random() * canvas.width, Math.random() * canvas.height, 1 + Math.random() * 2, 1)
  }
  ctx.strokeStyle = "rgba(220,230,220,.13)"
  ctx.lineWidth = 2
  for (let p = 0; p <= 512; p += 128) {
    ctx.beginPath()
    ctx.moveTo(p, 0)
    ctx.lineTo(p, 512)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(0, p)
    ctx.lineTo(512, p)
    ctx.stroke()
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(6, 6)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function cylinderBetween(mesh: THREE.Mesh, start: THREE.Vector3, end: THREE.Vector3) {
  const midpoint = start.clone().add(end).multiplyScalar(0.5)
  const direction = end.clone().sub(start)
  const length = direction.length()
  mesh.position.copy(midpoint)
  mesh.scale.set(1, length, 1)
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
}

function robotPoints(pose: RobotPose) {
  const yaw = pose.yaw * 0.06
  const base = new THREE.Vector3(0, 7, 23)
  const shoulder = new THREE.Vector3(yaw, 22 + pose.z * 0.08, 11)
  const elbow = new THREE.Vector3(pose.x * 0.24, 26 + pose.z * 0.18, -pose.y * 0.38)
  const wrist = new THREE.Vector3(pose.x * 0.48 + yaw, 15 + pose.z * 0.5, -pose.y * 0.72)
  return { base, shoulder, elbow, wrist }
}

function targetVector(target: TargetPose) {
  return new THREE.Vector3(target.x, target.z, -target.y)
}

function setupRobotScene(
  container: HTMLDivElement,
  readState: () => { pose: RobotPose; target: TargetPose; loop: string },
) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
    preserveDrawingBuffer: true,
  })
  renderer.domElement.dataset.robotScene = "true"
  renderer.domElement.className = "absolute inset-0 z-0 size-full"
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.08
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x12171a)
  scene.fog = new THREE.Fog(0x12171a, 70, 180)
  const pmrem = new THREE.PMREMGenerator(renderer)
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environment = environment

  const camera = new THREE.PerspectiveCamera(64, 1, 0.1, 240)
  camera.position.set(0, 31, 66)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.minDistance = 18
  controls.maxDistance = 180
  controls.maxPolarAngle = Math.PI * 0.495
  controls.target.set(0, 24, 0)
  controls.update()
  let userOrbiting = false
  controls.addEventListener("start", () => {
    userOrbiting = true
  })
  const resetOrbit = () => {
    userOrbiting = false
    controls.reset()
  }
  renderer.domElement.addEventListener("dblclick", resetOrbit)

  const ambient = new THREE.HemisphereLight(0xf4fbff, 0x27342c, 1.8)
  scene.add(ambient)

  const key = new THREE.DirectionalLight(0xffffff, 4.6)
  key.position.set(-36, 74, 46)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.camera.near = 10
  key.shadow.camera.far = 180
  key.shadow.camera.left = -80
  key.shadow.camera.right = 80
  key.shadow.camera.top = 80
  key.shadow.camera.bottom = -80
  scene.add(key)

  const targetLight = new THREE.PointLight(0xffa55b, 1.6, 70)
  scene.add(targetLight)

  const cameraFill = new THREE.SpotLight(0xcfe8ff, 1.2, 160, Math.PI / 5, 0.58, 1.1)
  cameraFill.position.set(0, 36, 56)
  cameraFill.target.position.set(0, 18, -46)
  scene.add(cameraFill, cameraFill.target)

  const concrete = makeConcreteTexture()
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x5d625f,
    map: concrete,
    bumpMap: concrete,
    bumpScale: 0.13,
    roughness: 0.84,
    metalness: 0.03,
  })
  const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x283038, roughness: 0.78, metalness: 0.08 })
  const benchMaterial = new THREE.MeshStandardMaterial({ color: 0x46515a, roughness: 0.48, metalness: 0.18 })
  const darkMetal = new THREE.MeshPhysicalMaterial({
    color: 0x59656d,
    roughness: 0.38,
    metalness: 0.75,
    clearcoat: 0.32,
    clearcoatRoughness: 0.45,
  })
  const brightMetal = new THREE.MeshPhysicalMaterial({
    color: 0xb7c2c5,
    roughness: 0.3,
    metalness: 0.86,
    clearcoat: 0.5,
    clearcoatRoughness: 0.3,
  })
  const jointMaterial = new THREE.MeshPhysicalMaterial({ color: 0x263039, roughness: 0.35, metalness: 0.7 })
  const targetMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xff9b3d,
    emissive: 0x5a2200,
    roughness: 0.32,
    metalness: 0.08,
  })

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(220, 220), floorMaterial)
  floor.rotation.x = -Math.PI / 2
  floor.position.set(0, 0, -42)
  floor.receiveShadow = true
  scene.add(floor)

  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(220, 110), wallMaterial)
  backWall.position.set(0, 55, -122)
  backWall.receiveShadow = true
  scene.add(backWall)

  const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(220, 110), wallMaterial)
  leftWall.rotation.y = Math.PI / 2
  leftWall.position.set(-92, 55, -42)
  leftWall.receiveShadow = true
  scene.add(leftWall)

  const stripMaterial = new THREE.MeshBasicMaterial({ color: 0xdceeff, transparent: true, opacity: 0.9 })
  for (const x of [-38, 28]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(32, 0.35, 2.5), stripMaterial)
    strip.position.set(x, 55, -36)
    scene.add(strip)
    const stripLight = new THREE.PointLight(0xdceeff, 0.9, 75)
    stripLight.position.set(x, 53, -36)
    scene.add(stripLight)
  }

  const bench = new THREE.Mesh(new THREE.BoxGeometry(58, 5, 28), benchMaterial)
  bench.position.set(18, 8, -58)
  bench.castShadow = true
  bench.receiveShadow = true
  scene.add(bench)

  const crateMaterial = new THREE.MeshStandardMaterial({ color: 0x72614b, roughness: 0.7, metalness: 0.05 })
  for (const [x, z, y] of [
    [-42, -78, 10],
    [-34, -78, 22],
    [54, -92, 12],
  ] as const) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(12, 12, 12), crateMaterial)
    crate.position.set(x, y, z)
    crate.castShadow = true
    crate.receiveShadow = true
    scene.add(crate)
  }

  const base = new THREE.Mesh(new THREE.CylinderGeometry(8, 10, 7, 48), jointMaterial)
  base.position.set(0, 3.5, 23)
  base.castShadow = true
  base.receiveShadow = true
  scene.add(base)

  const segmentGeometry = new THREE.CylinderGeometry(1.9, 1.9, 1, 32)
  const wristGeometry = new THREE.CylinderGeometry(1.35, 1.35, 1, 32)
  const segments = [
    new THREE.Mesh(segmentGeometry, darkMetal),
    new THREE.Mesh(segmentGeometry, darkMetal),
    new THREE.Mesh(wristGeometry, brightMetal),
  ]
  for (const segment of segments) {
    segment.castShadow = true
    segment.receiveShadow = true
    scene.add(segment)
  }

  const jointGeometry = new THREE.SphereGeometry(3.2, 32, 16)
  const joints = [0, 1, 2, 3].map(() => {
    const joint = new THREE.Mesh(jointGeometry, jointMaterial)
    joint.castShadow = true
    scene.add(joint)
    return joint
  })

  const gripper = new THREE.Group()
  const palm = new THREE.Mesh(new THREE.BoxGeometry(5, 3, 3), brightMetal)
  const leftFinger = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.2, 7), brightMetal)
  const rightFinger = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.2, 7), brightMetal)
  palm.castShadow = true
  leftFinger.castShadow = true
  rightFinger.castShadow = true
  leftFinger.position.z = -4.5
  rightFinger.position.z = -4.5
  gripper.add(palm, leftFinger, rightFinger)
  scene.add(gripper)

  const targetMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(4.2, 2), targetMaterial)
  targetMesh.castShadow = true
  scene.add(targetMesh)

  const targetHalo = new THREE.Mesh(
    new THREE.TorusGeometry(6.2, 0.18, 16, 80),
    new THREE.MeshBasicMaterial({ color: 0xffb25d, transparent: true, opacity: 0.72 }),
  )
  scene.add(targetHalo)

  const resize = () => {
    const rect = container.getBoundingClientRect()
    const width = Math.max(1, Math.floor(rect.width))
    const height = Math.max(1, Math.floor(rect.height))
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }

  const observer = new ResizeObserver(resize)
  observer.observe(container)
  resize()

  let animation = 0
  const render = () => {
    const { pose, target, loop } = readState()
    const points = robotPoints(pose)
    cylinderBetween(segments[0], points.base, points.shoulder)
    cylinderBetween(segments[1], points.shoulder, points.elbow)
    cylinderBetween(segments[2], points.elbow, points.wrist)
    joints[0].position.copy(points.base)
    joints[1].position.copy(points.shoulder)
    joints[2].position.copy(points.elbow)
    joints[3].position.copy(points.wrist)

    const gripGap = 4.2 - pose.grip * 0.027
    gripper.position.copy(points.wrist)
    gripper.lookAt(points.wrist.clone().add(new THREE.Vector3(pose.x * 0.02, -0.1, -8)))
    leftFinger.position.x = -gripGap
    rightFinger.position.x = gripGap

    const targetPosition = targetVector(target)
    targetMesh.position.copy(targetPosition)
    targetHalo.position.copy(targetPosition)
    targetHalo.rotation.y += loop === "running" ? 0.04 : 0.012
    targetLight.position.copy(targetPosition).add(new THREE.Vector3(0, 14, 12))

    if (!userOrbiting) {
      controls.target.set(pose.x * 0.18, 24, -54)
      camera.position.set(pose.x * 0.035, 31 + pose.z * 0.035, 66)
    }
    controls.update()
    renderer.render(scene, camera)
    animation = requestAnimationFrame(render)
  }
  animation = requestAnimationFrame(render)

  return () => {
    cancelAnimationFrame(animation)
    observer.disconnect()
    renderer.domElement.removeEventListener("dblclick", resetOrbit)
    controls.dispose()
    renderer.dispose()
    environment.dispose()
    pmrem.dispose()
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      mesh.geometry?.dispose?.()
      const material = mesh.material
      if (Array.isArray(material)) material.forEach((item) => item.dispose())
      else material?.dispose?.()
    })
    concrete?.dispose()
    renderer.domElement.remove()
  }
}

const ROBOT_MODEL_STORAGE = "opencode.robotLab.model"

export default function Robotics() {
  let viewportRef: HTMLDivElement | undefined
  const models = useModels()
  const globalSDK = useGlobalSDK()
  const local = useLocal()
  const platform = usePlatform()
  const server = useServer()

  const visibleRobotModels = createMemo(() =>
    models
      .list()
      .filter((m) => models.visible({ providerID: m.provider.id, modelID: m.id }))
      .sort((a, b) => a.provider.name.localeCompare(b.provider.name) || a.name.localeCompare(b.name)),
  )

  const currentLocalModelValue = () => {
    const current = local.model.current()
    return current ? `${current.provider.id}/${current.id}` : ""
  }

  const initialModel = (() => {
    try {
      return localStorage.getItem(ROBOT_MODEL_STORAGE) ?? currentLocalModelValue()
    } catch {
      return currentLocalModelValue()
    }
  })()
  const [selectedModel, setSelectedModelRaw] = createSignal(initialModel)
  const setSelectedModel = (next: string) => {
    try {
      if (next) {
        localStorage.setItem(ROBOT_MODEL_STORAGE, next)
        const [providerID, ...rest] = next.split("/")
        const modelID = rest.join("/")
        if (providerID && modelID) models.recent.push({ providerID, modelID })
      } else {
        localStorage.removeItem(ROBOT_MODEL_STORAGE)
      }
    } catch {}
    setSelectedModelRaw(next)
  }
  const modelBody = () => {
    const v = selectedModel()
    if (!v) return undefined
    const [providerID, ...rest] = v.split("/")
    const modelID = rest.join("/")
    if (!providerID || !modelID) return undefined
    return { providerID, modelID }
  }
  const modelLabel = createMemo(() => {
    const m = visibleRobotModels().find((x) => `${x.provider.id}/${x.id}` === selectedModel())
    return m ? `${m.provider.name} / ${m.name}` : "heuristic (no model)"
  })

  const [store, setStore] = createStore({
    transport: "simulator" as TransportKind,
    controller: "agi-vision" as ControllerKind,
    loop: "idle" as "idle" | "running" | "stopped",
    frame: 1,
    pose: { ...DEFAULT_POSE },
    target: { ...DEFAULT_TARGET },
    image: observeImage(DEFAULT_POSE, DEFAULT_TARGET),
    command: ZERO_COMMAND,
    busy: false,
    modality: "local" as "local" | "vision" | "text",
    supportsImage: false,
    logs: ["AGI vision policy simulator ready. First-person 3D image feed is synthetic."],
  })

  const headers = (json = false) => {
    const h: Record<string, string> = { accept: "application/json" }
    if (json) h["content-type"] = "application/json"
    const http = server.current?.http
    if (http?.password) h.authorization = `Basic ${btoa(`${http.username ?? "opencode"}:${http.password}`)}`
    return h
  }

  const captureFrame = () => {
    const canvas = viewportRef?.querySelector('canvas[data-robot-scene="true"]') as HTMLCanvasElement | null
    if (!canvas) return undefined
    try {
      return canvas.toDataURL("image/png")
    } catch {
      return undefined
    }
  }

  const pushLog = (line: string) => {
    const stamped = `${new Date().toLocaleTimeString([], { hour12: false })}  ${line}`
    setStore("logs", (items) => [stamped, ...items].slice(0, 7))
  }

  const setCommandedPose = (command: RobotCommand) => {
    const nextPose = applyCommand(store.pose, command)
    const nextImage = observeImage(nextPose, store.target)
    batch(() => {
      setStore("pose", nextPose)
      setStore("image", nextImage)
      setStore("command", command)
      setStore("frame", (frame) => frame + 1)
    })
  }

  const sceneDescription = (frame: VisionFrame) => {
    const dx = store.target.x - store.pose.x
    const dy = store.target.y - store.pose.y
    const dz = store.target.z - store.pose.z
    return [
      `target_visible=${frame.confidence > 0.4}`,
      `target_screen_offset_x_pct=${frame.offsetX.toFixed(1)} (negative=left, positive=right)`,
      `target_screen_offset_y_pct=${frame.offsetY.toFixed(1)} (negative=above, positive=below)`,
      `distance_gripper_to_target=${frame.depth.toFixed(2)}`,
      `pose: x=${store.pose.x.toFixed(1)}, y=${store.pose.y.toFixed(1)}, z=${store.pose.z.toFixed(1)}, yaw=${store.pose.yaw.toFixed(1)}, grip=${store.pose.grip.toFixed(1)}`,
      `target_xyz=${store.target.x.toFixed(1)},${store.target.y.toFixed(1)},${store.target.z.toFixed(1)}`,
      `vector_gripper_to_target: dx=${dx.toFixed(1)}, dy=${dy.toFixed(1)}, dz=${dz.toFixed(1)}`,
      `close_gripper_when_distance_under_5=${frame.depth < 5}`,
    ].join("\n")
  }

  const stepLoop = async (label = "AGI vision loop") => {
    if (store.busy || store.loop === "stopped") return
    const frame = observeImage(store.pose, store.target)
    const m = modelBody()
    setStore("busy", true)
    if (!m) {
      try {
        const command = imageServoCommand(frame, store.pose, store.target)
        batch(() => {
          setStore("modality", "local")
          setStore("supportsImage", false)
        })
        setCommandedPose(command)
        if (store.frame % 6 === 0) {
          pushLog(`${label}: ${command.label} (heuristic) depth=${frame.depth.toFixed(1)}`)
        }
      } finally {
        setStore("busy", false)
      }
      return
    }
    try {
      const fetcher = platform.fetch ?? fetch
      const res = await fetcher(`${globalSDK.url}/robot/step`, {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify({
          goal: "Reach the target and grasp it.",
          fpv: captureFrame(),
          sceneDescription: sceneDescription(frame),
          joints: {
            base: store.pose.yaw,
            shoulder: store.pose.z * 0.5,
            elbow: -store.pose.y * 0.5,
            wrist: store.pose.x * 0.25,
            gripper: store.pose.grip > 50 ? "closed" : "open",
          },
          targetHeld: targetDistance() < 5 && store.pose.grip > 75,
          model: m,
        }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(text || `HTTP ${res.status}`)
      }
      const action = (await res.json()) as RobotAction
      const command: RobotCommand = {
        x: clamp((action.wristDelta ?? 0) * 0.35, -2.8, 2.8),
        y: clamp(-(action.elbowDelta ?? 0) * 0.3, -2.8, 2.8),
        z: clamp((action.shoulderDelta ?? 0) * 0.25, -2.2, 2.2),
        yaw: clamp((action.baseDelta ?? 0) * 0.12, -1.4, 1.4),
        grip: action.gripper === "closed" ? 2.4 : action.gripper === "open" ? -0.8 : 0,
        label: action.modality ? `ai/${action.modality}` : "ai policy",
      }
      batch(() => {
        setStore("modality", action.modality ?? "text")
        setStore("supportsImage", Boolean(action.supportsImage))
      })
      setCommandedPose(command)
      pushLog(`${label} [${action.modality ?? "ai"}]: ${action.reasoning ?? "bounded action returned"}`)
    } catch (cause) {
      const command = imageServoCommand(frame, store.pose, store.target)
      batch(() => {
        setStore("modality", "local")
        setStore("supportsImage", false)
      })
      setCommandedPose(command)
      pushLog(`${label} [fallback]: ${cause instanceof Error ? cause.message : String(cause)} -> heuristic`)
    } finally {
      setStore("busy", false)
    }
  }

  const manual = (command: Omit<RobotCommand, "label">, label: string) => {
    setCommandedPose({ ...command, label })
    pushLog(`manual: ${label}`)
  }

  const home = () => {
    batch(() => {
      setStore("pose", { ...DEFAULT_POSE })
      setStore("target", { ...DEFAULT_TARGET })
      setStore("image", observeImage(DEFAULT_POSE, DEFAULT_TARGET))
      setStore("command", ZERO_COMMAND)
      setStore("loop", "idle")
      setStore("frame", (frame) => frame + 1)
    })
    pushLog("returned to simulator home pose")
  }

  const stop = () => {
    batch(() => {
      setStore("loop", "stopped")
      setStore("command", { ...ZERO_COMMAND, label: "emergency stop" })
    })
    pushLog("emergency stop latched; simulator commands zeroed")
  }

  onMount(() => {
    const loopTimer = setInterval(() => {
      if (store.loop !== "running") return
      void stepLoop()
    }, 900)

    const disposeScene = viewportRef
      ? setupRobotScene(viewportRef, () => ({ pose: store.pose, target: store.target, loop: store.loop }))
      : undefined

    onCleanup(() => {
      clearInterval(loopTimer)
      disposeScene?.()
    })
  })

  const targetStyle = createMemo(() => ({
    left: `${store.image.targetX}%`,
    top: `${store.image.targetY}%`,
  }))

  const reticleAligned = createMemo(() => Math.abs(store.image.offsetX) < 4 && Math.abs(store.image.offsetY) < 4)
  const targetDistance = createMemo(() => distance(store.pose, store.target))

  const controls = [
    { label: "Left", icon: "arrow-left" as const, command: { x: -3, y: 0, z: 0, yaw: 0, grip: 0 } },
    { label: "Right", icon: "arrow-right" as const, command: { x: 3, y: 0, z: 0, yaw: 0, grip: 0 } },
    { label: "Up", icon: "arrow-up" as const, command: { x: 0, y: 0, z: 3, yaw: 0, grip: 0 } },
    { label: "Down", icon: "arrow-down-to-line" as const, command: { x: 0, y: 0, z: -3, yaw: 0, grip: 0 } },
    { label: "Forward", icon: "enter" as const, command: { x: 0, y: 4, z: 0, yaw: 0, grip: 0 } },
    { label: "Back", icon: "reset" as const, command: { x: 0, y: -4, z: 0, yaw: 0, grip: 0 } },
  ]

  return (
    <div class="size-full overflow-y-auto no-scrollbar px-4 py-5 sm:px-7">
      <div class="mx-auto flex w-full max-w-[1280px] flex-col gap-5">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex min-w-0 flex-col gap-1">
            <div class="flex flex-wrap items-center gap-2">
              <h1 class="text-16-medium text-text-strong">Robot lab</h1>
              <Tag>experimental</Tag>
              <Tag>AGI vision</Tag>
              <Tag>3D</Tag>
              <Tag>{store.transport}</Tag>
              <Tag>{store.loop}</Tag>
              <Show when={store.busy}>
                <Tag>model busy</Tag>
              </Show>
            </div>
            <p class="text-12-regular text-text-weak">
              Simulates an image-capable AGI controller reading the first-person camera frame and emitting bounded arm
              commands. Hardware transport is intentionally not connected.
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <Button
              size="small"
              variant={store.loop === "running" ? "secondary" : "primary"}
              icon={store.loop === "running" ? "stop" : "arrow-up"}
              disabled={store.busy && store.loop !== "running"}
              onClick={() => {
                const next = store.loop === "running" ? "idle" : "running"
                setStore("loop", next)
                pushLog(next === "running" ? "AGI vision loop started" : "AGI vision loop paused")
              }}
            >
              {store.loop === "running" ? "Pause loop" : "Start AGI loop"}
            </Button>
            <Button
              size="small"
              variant="secondary"
              icon="enter"
              disabled={store.busy || store.loop === "stopped"}
              onClick={() => void stepLoop("single step")}
            >
              Step
            </Button>
            <Button size="small" variant="secondary" icon="reset" onClick={home}>
              Home
            </Button>
            <Button size="small" variant="ghost" icon="circle-ban-sign" onClick={stop}>
              E-stop
            </Button>
          </div>
        </div>

        <div class="grid min-h-0 grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section class="flex min-w-0 flex-col gap-3">
            <div
              ref={(el) => {
                viewportRef = el
              }}
              class="relative aspect-video min-h-[360px] overflow-hidden rounded-lg border border-border-base bg-black shadow-sm"
              data-robot-viewport="3d"
            >
              <div
                class="absolute z-10 size-8 -translate-x-1/2 -translate-y-1/2 rounded-full border border-text-warning-base bg-surface-warning-base/30 shadow-[0_0_24px_rgba(244,180,80,.35)]"
                style={targetStyle()}
              >
                <div class="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-text-warning-base/70" />
                <div class="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-text-warning-base/70" />
              </div>

              <div class="absolute left-1/2 top-1/2 z-10 size-16 -translate-x-1/2 -translate-y-1/2">
                <div
                  class="absolute inset-0 rounded-full border"
                  classList={{
                    "border-icon-success-base shadow-[0_0_28px_rgba(70,200,140,.25)]": reticleAligned(),
                    "border-border-strong-base": !reticleAligned(),
                  }}
                />
                <div class="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-border-strong-base" />
                <div class="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-border-strong-base" />
              </div>

              <div class="absolute left-3 top-3 z-10 flex flex-wrap gap-2 text-11-medium">
                <Tag>frame {store.frame}</Tag>
                <Tag>depth {store.image.depth.toFixed(1)}</Tag>
                <Tag>confidence {(store.image.confidence * 100).toFixed(0)}%</Tag>
                <Tag>image input</Tag>
                <Tag>webgl</Tag>
              </div>
              <div class="absolute bottom-3 left-3 right-3 z-10 flex items-center justify-between gap-2 text-11-regular text-text-weak">
                <span>drag to orbit, wheel to zoom, double-click reset</span>
                <span>{reticleAligned() ? "target centered" : "servo correcting"}</span>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Metric label="X" value={store.pose.x.toFixed(1)} />
              <Metric label="Y" value={store.pose.y.toFixed(1)} />
              <Metric label="Z" value={store.pose.z.toFixed(1)} />
              <Metric label="Yaw" value={`${store.pose.yaw.toFixed(1)} deg`} />
              <Metric label="Grip" value={`${store.pose.grip.toFixed(0)}%`} />
            </div>
          </section>

          <aside class="flex min-w-0 flex-col gap-4">
            <section class="rounded-lg border border-border-base bg-surface-base p-4">
              <div class="mb-3 flex items-center justify-between gap-3">
                <h2 class="text-14-medium text-text-strong">Manual jog</h2>
                <Tag>{store.command.label}</Tag>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <For each={controls}>
                  {(control) => (
                    <Button
                      size="small"
                      variant="secondary"
                      icon={control.icon}
                      onClick={() => manual(control.command, control.label.toLowerCase())}
                    >
                      {control.label}
                    </Button>
                  )}
                </For>
              </div>
              <div class="mt-3 grid grid-cols-2 gap-2">
                <Button
                  size="small"
                  variant="ghost"
                  icon="arrow-left"
                  onClick={() => manual({ x: 0, y: 0, z: 0, yaw: -4, grip: 0 }, "yaw left")}
                >
                  Yaw left
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  icon="arrow-right"
                  onClick={() => manual({ x: 0, y: 0, z: 0, yaw: 4, grip: 0 }, "yaw right")}
                >
                  Yaw right
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  icon="plus-small"
                  onClick={() => manual({ x: 0, y: 0, z: 0, yaw: 0, grip: 8 }, "close grip")}
                >
                  Close
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  icon="dash"
                  onClick={() => manual({ x: 0, y: 0, z: 0, yaw: 0, grip: -8 }, "open grip")}
                >
                  Open
                </Button>
              </div>
            </section>

            <section class="rounded-lg border border-border-base bg-surface-base p-4">
              <div class="mb-3 flex items-center justify-between gap-3">
                <h2 class="text-14-medium text-text-strong">AGI control loop</h2>
                <Icon name="window-cursor" size="small" class="text-icon-weak" />
              </div>
              <div class="mb-3 flex flex-col gap-1.5">
                <label class="text-11-regular text-text-weak">Controller model</label>
                <select
                  value={selectedModel()}
                  onChange={(e) => setSelectedModel(e.currentTarget.value)}
                  disabled={store.busy}
                  class="h-8 rounded-md border border-border-base bg-surface-base px-2 text-12-regular text-text-base outline-none"
                >
                  <option value="">Heuristic (no model)</option>
                  <For each={visibleRobotModels()}>
                    {(m) => (
                      <option value={`${m.provider.id}/${m.id}`}>
                        {m.provider.name} / {m.name}
                      </option>
                    )}
                  </For>
                </select>
                <span class="text-11-regular text-text-weak">{modelLabel()}</span>
              </div>
              <div class="flex flex-col gap-2 text-12-regular text-text-base">
                <LoopRow label="Controller" value={store.busy ? "waiting for model" : "image-capable AGI policy"} />
                <LoopRow label="Model path" value={store.modality === "local" ? "local fallback" : `ai/${store.modality}`} />
                <LoopRow label="Image input" value={store.supportsImage ? "canvas PNG + text observation" : "text observation"} />
                <LoopRow label="Action schema" value="dx, dy, dz, yaw, grip" />
                <LoopRow
                  label="Image offset"
                  value={`${store.image.offsetX.toFixed(1)}px, ${store.image.offsetY.toFixed(1)}px`}
                />
                <LoopRow label="Target distance" value={targetDistance().toFixed(1)} />
                <LoopRow
                  label="Command"
                  value={`${store.command.x.toFixed(1)}, ${store.command.y.toFixed(1)}, ${store.command.z.toFixed(1)}`}
                />
                <LoopRow
                  label="Transport"
                  value={store.transport === "simulator" ? "simulator bridge" : "hardware bridge"}
                />
              </div>
              <Show when={store.transport === "hardware"}>
                <p class="mt-3 text-12-regular text-text-warning-base">
                  Hardware bridge is reserved and disabled in this build.
                </p>
              </Show>
            </section>

            <section class="rounded-lg border border-border-base bg-surface-base p-4">
              <h2 class="mb-3 text-14-medium text-text-strong">Event trace</h2>
              <div class="flex flex-col gap-2">
                <For each={store.logs}>
                  {(line) => (
                    <div class="rounded border border-border-weak-base bg-background-base px-2 py-1 text-11-mono text-text-base">
                      {line}
                    </div>
                  )}
                </For>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}

function Metric(props: { label: string; value: string }) {
  return (
    <div class="rounded-lg border border-border-base bg-surface-base px-3 py-2">
      <div class="text-11-medium text-text-weak">{props.label}</div>
      <div class="text-16-medium text-text-strong">{props.value}</div>
    </div>
  )
}

function LoopRow(props: { label: string; value: string }) {
  return (
    <div class="flex items-center justify-between gap-3 border-b border-border-weak-base py-1.5 last:border-none">
      <span class="text-text-weak">{props.label}</span>
      <span class="text-12-mono text-text-strong">{props.value}</span>
    </div>
  )
}
