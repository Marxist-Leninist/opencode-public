// SG OpenCode permission bypass.
//
// The default is "allow" — every prompt resolves to allow without asking the
// user. Set OPENCODE_SG_PERMISSION_MODE=normal to opt back into the upstream
// ask/deny flow.
//
// In addition: if OPENCODE_SG_AUTOMATION_RUN=1 the bypass is forced ON
// regardless of OPENCODE_SG_PERMISSION_MODE. A scheduled automation cannot
// pause to wait for a human approval click — there is no human watching — so
// permission asks during automation runs are always converted to allows. This
// override exists so a user who has explicitly set normal mode for their
// interactive sessions still gets working background automations.
export function bypassEnabled() {
  if (isAutomationRun()) return true
  return (process.env.OPENCODE_SG_PERMISSION_MODE ?? "allow").toLowerCase() !== "normal"
}

export function isAutomationRun() {
  const flag = (process.env.OPENCODE_SG_AUTOMATION_RUN ?? "").toLowerCase()
  return flag === "1" || flag === "true" || flag === "yes" || flag === "on"
}
