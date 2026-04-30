import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { Effect } from "effect"
import { generateText } from "ai"
import z from "zod"
import { Provider } from "@/provider"
import { ProviderID, ModelID } from "@/provider/schema"
import { lazy } from "@/util/lazy"
import { errors } from "../../error"
import { jsonRequest } from "./trace"

const Joints = z.object({
  base: z.number(),
  shoulder: z.number(),
  elbow: z.number(),
  wrist: z.number(),
  gripper: z.enum(["open", "closed"]),
})

const StepInput = z.object({
  goal: z.string().min(1).max(1000),
  fpv: z.string().min(1).optional().describe("Data URL or base64 PNG of the robot's first-person view"),
  scene: z.string().optional().describe("Optional god-eye context image"),
  sceneDescription: z
    .string()
    .max(4000)
    .optional()
    .describe("Text description of the scene for non-vision models (target position, gripper position, distances, etc.)"),
  joints: Joints,
  targetHeld: z.boolean().optional(),
  model: z
    .object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
    })
    .optional(),
})

const ActionResponse = z.object({
  baseDelta: z.number(),
  shoulderDelta: z.number(),
  elbowDelta: z.number(),
  wristDelta: z.number(),
  gripper: z.enum(["open", "closed"]),
  reasoning: z.string(),
  model: z.object({
    providerID: z.string(),
    modelID: z.string(),
  }),
  modality: z.enum(["vision", "text"]),
  supportsImage: z.boolean(),
})

const SYSTEM_PROMPT = `You are a robotic arm controller for an experimental SG OpenCode simulator.

You may receive either:
- image mode: the robot's first-person camera frame (FPV), optionally with a god-eye context image
- text-observation mode: a structured text description extracted from the simulator's image/pose state for text-only models

Treat the text observation as a compact representation of the image. The arm has 5 controllable joints:
- base (yaw, -180..180 deg) - rotates the whole arm horizontally
- shoulder (-10..90 deg) - lifts the upper arm; positive = up
- elbow (-120..30 deg) - bends the forearm; negative = bent forward/down
- wrist (-90..90 deg) - rotates the gripper end
- gripper ("open" | "closed")

You output INCREMENTAL DELTAS for each numeric joint, capped to roughly +/-10 degrees per step. Smaller steps are safer.

Return strict JSON only (no prose, no code fences):
{
  "baseDelta": <number>,
  "shoulderDelta": <number>,
  "elbowDelta": <number>,
  "wristDelta": <number>,
  "gripper": "open" | "closed",
  "reasoning": "<one short sentence>"
}

Strategy guidance:
- If target_screen_offset_x_pct is negative, target is LEFT of the FPV crosshair and baseDelta should be POSITIVE (yaw left).
- If target_screen_offset_x_pct is positive, target is RIGHT of the FPV crosshair and baseDelta should be NEGATIVE.
- If target_screen_offset_y_pct is positive, target is BELOW crosshair; shoulderDelta NEGATIVE or elbowDelta NEGATIVE to lower.
- If target_screen_offset_y_pct is negative, target is ABOVE crosshair; shoulderDelta POSITIVE.
- When the target visually fills a large fraction of the FPV (you are close), set gripper "closed" to grasp.
- When holding a target and you've reached the destination, set gripper "open" to release.
- Bias toward small deltas: <=5 degrees when target is near, <=10 when far.`

function isKnownTextOnlyModel(providerID: string, modelID: string) {
  const key = `${providerID}/${modelID}`.toLowerCase()
  return (
    key.includes("deepseek") ||
    key.includes("mercury-2") ||
    key.includes("mercury-coder") ||
    key.includes("openrouter/auto") ||
    key.includes("openrouter/free")
  )
}

function canSendImages(providerID: string, modelID: string, model: { capabilities?: { input?: { image?: boolean } } }) {
  if (isKnownTextOnlyModel(providerID, modelID)) return false
  return Boolean(model.capabilities?.input?.image)
}

function stripDataUrl(input: string): { data: Uint8Array; mediaType: string } {
  const match = /^data:(.+?);base64,(.+)$/.exec(input)
  if (match) {
    const mediaType = match[1]
    const data = Uint8Array.from(Buffer.from(match[2], "base64"))
    return { data, mediaType }
  }
  return { data: Uint8Array.from(Buffer.from(input, "base64")), mediaType: "image/png" }
}

function tryParseAction(text: string): {
  baseDelta: number
  shoulderDelta: number
  elbowDelta: number
  wristDelta: number
  gripper: "open" | "closed"
  reasoning: string
} {
  const trimmed = text.trim()
  const candidates: string[] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === "{") {
      if (depth === 0) start = i
      depth++
    } else if (ch === "}") {
      depth--
      if (depth === 0 && start >= 0) {
        candidates.push(trimmed.slice(start, i + 1))
        start = -1
      }
    }
  }
  candidates.push(trimmed)
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      const num = (v: unknown, fallback = 0) =>
        typeof v === "number" && Number.isFinite(v) ? Math.max(-15, Math.min(15, v)) : fallback
      const grip = parsed.gripper === "closed" ? "closed" : parsed.gripper === "open" ? "open" : null
      if (grip === null) continue
      return {
        baseDelta: num(parsed.baseDelta),
        shoulderDelta: num(parsed.shoulderDelta),
        elbowDelta: num(parsed.elbowDelta),
        wristDelta: num(parsed.wristDelta),
        gripper: grip,
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 280) : "",
      }
    } catch {
      continue
    }
  }
  return {
    baseDelta: 0,
    shoulderDelta: 0,
    elbowDelta: 0,
    wristDelta: 0,
    gripper: "open",
    reasoning: "no parseable JSON in model output",
  }
}

export const RobotRoutes = lazy(() =>
  new Hono().post(
    "/step",
    describeRoute({
      summary: "Robot vision-control step",
      description:
        "Takes an FPV image plus current joint state and asks a vision-capable model for the next action. Experimental.",
      operationId: "robot.step",
      responses: {
        200: {
          description: "Action returned by the vision model",
          content: {
            "application/json": {
              schema: resolver(ActionResponse),
            },
          },
        },
        ...errors(400, 500),
      },
    }),
    validator("json", StepInput),
    async (c) =>
      jsonRequest("RobotRoutes.step", c, function* () {
        const body = c.req.valid("json")
        const provider = yield* Provider.Service
        const ref = body.model ?? (yield* provider.defaultModel())
        const model = yield* provider.getModel(ref.providerID, ref.modelID)
        const language = yield* provider.getLanguage(model)

        const supportsImage = canSendImages(ref.providerID, ref.modelID, model)

        const stateText = `Goal: ${body.goal}
Current joints: base=${body.joints.base.toFixed(1)} shoulder=${body.joints.shoulder.toFixed(1)} elbow=${body.joints.elbow.toFixed(1)} wrist=${body.joints.wrist.toFixed(1)} gripper=${body.joints.gripper}
Target held: ${body.targetHeld ?? false}`

        const userParts: Array<
          { type: "text"; text: string } | { type: "image"; image: Uint8Array; mediaType: string }
        > = [{ type: "text", text: stateText }]

        if (supportsImage && body.fpv) {
          const fpv = stripDataUrl(body.fpv)
          userParts.push({ type: "text", text: "Mode: image. First-person view follows." })
          userParts.push({ type: "image", image: fpv.data, mediaType: fpv.mediaType })
          if (body.scene) {
            const sceneImage = stripDataUrl(body.scene)
            userParts.push({ type: "text", text: "God-eye context (for reference only):" })
            userParts.push({ type: "image", image: sceneImage.data, mediaType: sceneImage.mediaType })
          }
          if (body.sceneDescription) {
            userParts.push({ type: "text", text: `Structured scene observation:\n${body.sceneDescription}` })
          }
        } else if (body.sceneDescription) {
          userParts.push({
            type: "text",
            text: `Mode: text-observation. Treat this structured scene observation as the image representation:\n${body.sceneDescription}`,
          })
        } else {
          return {
            baseDelta: 0,
            shoulderDelta: 0,
            elbowDelta: 0,
            wristDelta: 0,
            gripper: body.joints.gripper,
            reasoning: `model ${ref.providerID}/${ref.modelID} is using text-observation mode, but no sceneDescription was provided`,
            model: { providerID: ref.providerID, modelID: ref.modelID },
            modality: "text" as const,
            supportsImage,
          }
        }

        userParts.push({
          type: "text",
          text: 'Reply with strict JSON only: {"baseDelta":number,"shoulderDelta":number,"elbowDelta":number,"wristDelta":number,"gripper":"open"|"closed","reasoning":"..."}',
        })

        const generated = yield* Effect.tryPromise({
          try: () =>
            generateText({
              model: language,
              temperature: 0,
              maxOutputTokens: 1500,
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userParts as any },
              ],
            }),
          catch: (cause) => cause,
        })

        const action = tryParseAction(generated.text)
        return {
          ...action,
          model: {
            providerID: ref.providerID,
            modelID: ref.modelID,
          },
          modality: supportsImage && body.fpv ? ("vision" as const) : ("text" as const),
          supportsImage,
        }
      }),
  ),
)
