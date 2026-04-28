export function bypassEnabled() {
  return (process.env.OPENCODE_SG_PERMISSION_MODE ?? "allow").toLowerCase() !== "normal"
}
