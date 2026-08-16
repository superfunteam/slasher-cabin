export const meta = {
  name: 'slasher-cabin-integration',
  description: 'Close the seams between independently-authored systems: boot health, event wiring, and an actually-playable night',
  phases: [
    { title: 'Triage', detail: 'boot the game and find every runtime failure' },
    { title: 'Wire', detail: 'fix the seams — one agent per owning file' },
    { title: 'Playtest', detail: 'drive an actual night end to end and report what is unplayable' },
  ],
}

const ROOT = '/Users/clark/Downloads/Source/slasher-cabin/.claude/worktrees/slasher-cabin-game-8bdb8b'
const URL = 'http://localhost:5173'

const BOOT = `
HOW TO INSPECT THE RUNNING GAME (the dev server is already up at ${URL}):

1. mcp__Claude_Browser__navigate to ${URL}/?debug
2. The engine takes ~6s to boot (procedural texture baking, terrain generation). Poll with
   mcp__Claude_Browser__javascript_tool until window.__ENGINE__ exists:
       JSON.stringify({booted: document.documentElement.dataset.booted, e: !!window.__ENGINE__})
   Do NOT judge anything before that is true — probing mid-boot produces false failures.
   NOTE: other agents may be editing files, which triggers a Vite hot reload and restarts boot.
   If your probe returns nothing, just poll again rather than concluding the system is broken.
3. Read errors: mcp__Claude_Browser__read_console_messages with onlyErrors true.
4. Inspect systems:
       const e = window.__ENGINE__, c = window.__CTX__;
       JSON.stringify({
         fps: Math.round(e.stats.fps), ms: +e.stats.ms.toFixed(1),
         draws: e.stats.drawCalls, tris: e.stats.triangles,
         systems: [...e.systems.keys()],
         failed: [...e.systems].filter(([k,v]) => v.__failed).map(([k]) => k),
       })
`

// ---------------------------------------------------------------------------- Triage

phase('Triage')

const PROBES = [
  {
    id: 'boot',
    label: 'boot-health',
    brief: `Find every system that fails to construct, init, or update.

Report for EACH of the 26 registered systems: did it register? did init() throw? is __failed set?
Then check the console for every error and warning and attribute each to a specific file.

Also verify the frame is actually being produced: fps > 0, drawCalls > 0, triangles > 0.
If drawCalls is under 10 the world is not rendering and that is the headline finding.

Report the FULL console error list verbatim, each mapped to the file you believe owns it.`,
  },
  {
    id: 'events',
    label: 'event-wiring',
    brief: `Verify the event bus is actually wired between systems. Systems were authored in
isolation against ARCHITECTURE.md §5, so the most likely integration failure is that one system
emits an event nobody listens for, or listens for a name nobody emits.

In the browser, instrument the bus and report real counts:

    const c = window.__CTX__;
    const seen = {};
    const origEmit = c.bus.emit.bind(c.bus);
    c.bus.emit = (ev, p) => { seen[ev] = (seen[ev]||0)+1; return origEmit(ev, p); };
    // also record listener counts for every canonical event:
    const EVENTS = ['game:start','night:begin','night:complete','player:move','player:footstep',
      'player:spotted','player:hidden','noise:emit','build:pickup','build:place','build:creak',
      'build:stage-complete','tool:missing','ui:toast','ui:subtitle','audio:sfx','audio:vo',
      'story:beat','weather:change'];
    // wait ~10 seconds of gameplay, then:
    JSON.stringify({emitted: seen, listeners: Object.fromEntries(EVENTS.map(e => [e, c.bus.listenerCount(e)]))})

Report: which canonical events have ZERO listeners (dead ends), which are never emitted
(dead sources), and which have listeners but were never fired during 10s of idle.
That table is the integration gap list.`,
  },
  {
    id: 'render',
    label: 'render-chain',
    brief: `Verify the rendering chain is actually composed end to end.

Check specifically:
  - Does Postprocessing.render() exist and is Engine calling it instead of renderer.render()?
    (Engine calls post.render() if the system exists — confirm it is not silently falling back.)
  - Does Postprocessing expose depthTexture and normalTexture, and does VolumetricFog actually
    consume them? Read both files and confirm the handoff is real, not a TODO.
  - Does Sky create and manage the moon DirectionalLight, and does the scene contain it?
  - Are Materials.globalUniforms being updated every frame? Check uTime is advancing:
    read it twice a second apart and confirm it changed.
  - Is Textures returning real baked textures, or silently falling back to flat colors?
    Check renderer.info.memory.textures and call Textures.get() on several names.
  - Count scene objects and lights:
      let meshes=0,lights=0; window.__CTX__.scene.traverse(o=>{if(o.isMesh||o.isInstancedMesh)meshes++;if(o.isLight)lights++});

Report actual numbers and name every broken handoff with the file that owns it.`,
  },
  {
    id: 'gameplay',
    label: 'gameplay-chain',
    brief: `Verify the gameplay systems are actually connected to each other.

Check by reading the files AND probing at runtime:
  - Does Player exist with position/velocity, and does it move when input is simulated?
  - Does Player emit noise:emit on footsteps, and does NoiseSystem receive them?
    (Instrument: count noise:emit events during simulated movement.)
  - Does Campers actually spawn agents? How many? Do they have positions on the navmesh?
    Are they moving over time? Sample agent positions twice, 3s apart, and report the deltas.
  - Does BuildSystem know about CabinSite's slots? Does CabinSite.slots have entries?
  - Does Blueprint.forNight(1) return a real BlueprintDef with panels and parts?
  - Does NightManager drive ctx.state.phase, and is state.timeOfNight advancing?

Report which links are genuinely wired and which are stubs/TODOs. Be specific: quote the line
where a handoff is faked with a constant if you find one — a system that LOOKS implemented but
returns a hardcoded value is the worst failure mode here and the one to hunt hardest for.`,
  },
]

const findings = await parallel(PROBES.map((p) => () =>
  agent(`You are integration-testing "Slasher Cabin: Some Assembly Required", a first-person
horror/puzzle game in Three.js. 26 systems were authored INDEPENDENTLY by different agents
against a shared contract (${ROOT}/ARCHITECTURE.md). Your job is to find where they fail to
actually connect.

${BOOT}

YOUR AREA: ${p.brief}

Read ${ROOT}/ARCHITECTURE.md first (especially §4 ctx and §5 the canonical event list).

You are DIAGNOSING, not fixing. Do not edit any file.

Return STRICT JSON:
{
  "area": "${p.id}",
  "measurements": { ...the actual numbers you observed... },
  "problems": [
    {"severity":"critical|major|minor", "file":"gameplay/Player.js",
     "problem":"specific description with the evidence you observed",
     "fix":"the specific implementable change"}
  ]
}
Report only what you actually measured. If you could not measure something, say so in
"measurements" rather than guessing.`,
    { label: `triage:${p.label}`, phase: 'Triage', effort: 'high' })
))

const parsed = findings.filter(Boolean).map((f) => {
  try { const m = String(f).match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null }
  catch { return null }
}).filter(Boolean)

const byFile = new Map()
for (const p of parsed) {
  for (const pr of p.problems ?? []) {
    if (!pr.file) continue
    const key = pr.file.replace(/^src\//, '')
    if (!byFile.has(key)) byFile.set(key, [])
    byFile.get(key).push({ ...pr, area: p.area })
  }
}

const targets = [...byFile.entries()]
  .map(([file, problems]) => ({
    file, problems,
    weight: problems.reduce((n, p) =>
      n + (p.severity === 'critical' ? 5 : p.severity === 'major' ? 3 : 1), 0),
  }))
  .sort((a, b) => b.weight - a.weight)
  .slice(0, 12)

log(`Triage found problems in ${byFile.size} files; repairing the ${targets.length} worst.`)

// ---------------------------------------------------------------------------- Wire

phase('Wire')

const repairs = await parallel(targets.map((t) => () =>
  agent(`You are fixing INTEGRATION defects in exactly one file.

YOUR FILE (the only file you may edit): ${ROOT}/src/${t.file}

Integration testers ran the game and observed these problems, which they attribute to your file.
These were MEASURED at runtime, not guessed:

${t.problems.map((p, i) => `${i + 1}. [${p.severity}] (found by the ${p.area} probe)
   PROBLEM: ${p.problem}
   PROPOSED FIX: ${p.fix}`).join('\n\n')}

Read ${ROOT}/ARCHITECTURE.md (§4 ctx, §5 canonical events) and your file, then fix every problem
you agree with. Where the tester is wrong, do not blindly apply the change — explain why in your
report and leave a code comment so it is not re-raised.

If a problem is that your file emits an event nobody listens to, or listens for one nobody emits,
fix YOUR side to match ARCHITECTURE.md §5 exactly. Do not invent new event names.

RULES: no Math.random(), no console.log (use src/core/Log.js), no allocation in update(),
null-check every ctx.systems.get(), keep dispose() correct. NEVER put a backtick inside a GLSL
comment or string — this codebase keeps shaders in template literals and one stray backtick
breaks the parse hundreds of lines away.

Verify and iterate until all pass:
  node --input-type=module --check < ${ROOT}/src/${t.file}
  curl -s -o /dev/null -w "%{http_code}" ${URL}/src/${t.file}    # 200
  cd ${ROOT} && node tools/check.mjs                             # no new FATAL

${BOOT}
Then boot the game and confirm you did not break it: no new console errors, fps still > 0,
drawCalls still > 0.

Return what you fixed, what you rejected and why, and confirmation the game still boots.`,
    { label: `wire:${t.file.split('/').pop()}`, phase: 'Wire', effort: 'high' })
))

// ---------------------------------------------------------------------------- Playtest

phase('Playtest')

const playtest = await agent(
  `PLAYTEST "Slasher Cabin: Some Assembly Required" end to end and report honestly whether it is
a game yet.

${BOOT}

You can drive the game from JavaScript. Use mcp__Claude_Browser__computer to click the canvas
(for pointer lock) and to send keys, and mcp__Claude_Browser__javascript_tool to inspect and to
synthesize input where clicking is impractical. Useful handles:
    const c = window.__CTX__, e = window.__ENGINE__;
    c.systems.get('NightManager'), c.systems.get('BuildSystem'), c.systems.get('Player'),
    c.systems.get('Campers'), c.state
You may call system methods directly to advance the game if the UI blocks you — but REPORT
whenever you had to do that, because it means a player could not have done it.

Answer these questions with evidence:
  1. Can you get from the title screen into Night 1? What did you have to do?
  2. Does the manual (Tab/B) open, and is a readable diagram actually drawn in it?
     Screenshot it. Is it wordless? Does it look like a flat-pack instruction sheet?
  3. Can the player move, and does it FEEL heavy and deliberate (check the acceleration numbers
     in Player.js against GAME_DESIGN.md §5)?
  4. Can you pick up a part and carry it? Does carrying slow you and swing the part?
  5. Can you place a part into a slot? Does a ghost preview appear? Does a wrong placement
     produce a visible, legible mistake on the structure?
  6. Does a wrong join eventually CREAK, and does the creak produce a noise:emit that a camper
     actually reacts to? This is the game's central causal chain — trace it explicitly and say
     whether it works end to end.
  7. Do campers patrol? Do their flashlights sweep? Can they detect you? Does the detection
     meter fill and drain?
  8. Does audio play at all? (AudioContext state, and whether any source has started.)
  9. Does the night progress toward dawn, and can a night be completed?

Then state plainly: IS THIS PLAYABLE? What is the single biggest thing stopping it from being
a game someone would enjoy? Give a prioritized list of the top 10 things to fix next, each with
the owning file.

Be brutally honest. Do not describe intent as if it were behavior — if a system exists but does
nothing observable, say that.`,
  { label: 'playtest', phase: 'Playtest', effort: 'high' },
)

return {
  triage: parsed,
  filesRepaired: targets.map((t) => t.file),
  repairs,
  playtest,
}
