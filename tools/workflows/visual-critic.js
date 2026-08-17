export const meta = {
  name: 'slasher-cabin-visual-critic',
  description: 'Screenshot the canonical shots, judge them against a AAA bar, fix what fails, repeat until the score holds',
  phases: [
    { title: 'Judge', detail: 'capture each canonical shot and critique it without mercy' },
    { title: 'Fix', detail: 'route each defect to the file that owns it and repair' },
    { title: 'Rejudge', detail: 'recapture and confirm the fix actually improved the frame' },
  ],
}

const ROOT = '/Users/clark/Downloads/Source/slasher-cabin/.claude/worktrees/slasher-cabin-game-8bdb8b'
const URL = 'http://127.0.0.1:5173'

/** Which shots to review this round, and which files own what they show. */
const SHOTS = args?.shots ?? [
  { id: 'site-wide',  owners: ['world/Terrain.js', 'world/Forest.js', 'world/CabinSite.js', 'render/VolumetricFog.js'] },
  { id: 'site-close', owners: ['world/CabinSite.js', 'render/Materials.js', 'render/Textures.js', 'gameplay/Flashlight.js'] },
  { id: 'ridge',      owners: ['world/Terrain.js', 'render/VolumetricFog.js', 'render/Postprocessing.js', 'world/Props.js'] },
  { id: 'camp-fire',  owners: ['world/Props.js', 'render/Postprocessing.js', 'render/VolumetricFog.js'] },
  { id: 'forest-deep',owners: ['world/Forest.js', 'render/VolumetricFog.js', 'gameplay/Flashlight.js', 'render/Materials.js'] },
  { id: 'moon',       owners: ['render/Sky.js', 'world/Forest.js', 'render/Postprocessing.js'] },
  { id: 'lake',       owners: ['world/Terrain.js', 'render/Sky.js', 'render/Postprocessing.js'] },
  { id: 'manual',     owners: ['ui/BlueprintUI.js', 'gameplay/Blueprint.js'] },
]

const CAPTURE = `
HOW TO CAPTURE A SHOT (follow exactly — a mis-captured frame produces a worthless critique):

1. mcp__Claude_Browser__navigate to ${URL}/?shot=<ID>&quality=ultra
2. The scene needs time to load AND the temporal effects (TAA, volumetric reprojection) need
   ~45 frames to converge. Poll with mcp__Claude_Browser__javascript_tool:
       document.documentElement.dataset.shotReady
   until it returns "true". If it is still not "true" after ~20 polls, capture anyway and SAY SO
   in your report — a frame that never converges is itself a defect worth reporting.
3. Check for errors first: mcp__Claude_Browser__read_console_messages with onlyErrors true.
   A shader compile error or a missing system explains a bad frame better than any art critique,
   so always report these BEFORE judging the image.
4. Also grab the objective stats:
       const e = window.__ENGINE__;
       JSON.stringify({fps: Math.round(e.stats.fps), ms: +e.stats.ms.toFixed(1),
         draws: e.stats.drawCalls, tris: e.stats.triangles,
         missing: [...e.systems].filter(([k,v]) => v.__failed).map(([k]) => k)})
5. mcp__Claude_Browser__computer with action "screenshot" to actually SEE the frame.
`

const RUBRIC = `
THE BAR: a player shown this frame beside a frame from a modern Call of Duty night-forest level
should not immediately identify yours as "the browser one".

You cannot diff against a real Call of Duty screenshot — you do not have one, and you should not
try to reproduce copyrighted art. Judge instead against your own knowledge of how those frames
are built. Be concrete about the difference, never vague.

YOU DO HAVE A CONCRETE REFERENCE TARGET. Two photographic key-art frames in this repo were
generated to embody the art direction exactly, and the engine is supposed to look like them:

    ${ROOT}/public/img/keyart-lake.png   — the lake at night: crushed blue-green blacks, moon
        through broken cloud, low mist sitting ON the water, a wet dock catching a rim of light
        in the foreground, and exactly ONE warm human light (a cabin window) with its reflection
        running down the water.
    ${ROOT}/public/img/keyart-site.png   — the build site: lantern-lit half-built timber frame,
        enormous shadows thrown up into the pines, rain falling through the beam.

READ THE RELEVANT ONE WITH THE Read TOOL and look at it before you judge. Then say explicitly,
for your frame: what does the reference have that the render does not? Name the specific missing
quality (mist sitting in a layer rather than filling the frame; the wet specular rim along the
dock boards; the single warm light against total blue-black; the way the far treeline loses
contrast but not detail). That comparison is the most useful thing in your report.

What actually separates AAA from a hobby WebGL scene — score each 1-10 and justify with what you
SEE in the image, quoting specific regions of the frame:

  1. TEXTURE DETAIL AT ALL SCALES. Is there visible surface structure at 10cm AND at 10m?
     Flat untextured polygons anywhere = automatic fail.
  2. LIGHT FALLOFF & CONTRAST. Physically plausible? Deep crushed blacks and blown highlights,
     or grey mush? Is the darkness DESIGNED or is it just underexposed?
  3. CONTACT & AMBIENT OCCLUSION. Does everything sit IN the ground, or does it float?
     Floating objects are the single most common tell.
  4. SILHOUETTE VARIETY. Repeated identical instances at identical scale? Obvious grid placement?
  5. ATMOSPHERIC DEPTH. Is there air between the camera and the far plane? Does fog have
     structure and height falloff, or is it a uniform grey wash?
  6. MATERIAL RESPONSE. Do wet surfaces read as wet — darker albedo, tight speculars, grazing
     sheen? Does metal read as metal?
  7. COMPOSITION. Something dark and near, something lit in the mid-ground, atmosphere behind?
  8. POST QUALITY. Is bloom physically motivated or a uniform haze? Is grain the right SIZE
     (film-like) or per-pixel white noise? Aliasing on high-contrast edges?
  9. COLOR. Does it match ART_DIRECTION.md's palette — blue-green night, warm light only where
     it is motivated? Any muddy or accidental hues?
 10. THE INDEFINABLE: does it look like a PLACE someone could be standing in, at night, cold?

Read ${ROOT}/ART_DIRECTION.md — especially its "failure modes" list — and explicitly check the
frame against every failure mode it names.

SCORING RULES:
  - Be harsh. 7/10 means "competent but visibly a web demo." Only give 9+ if you would genuinely
    struggle to tell it from a shipped AAA frame.
  - Do NOT praise. Every sentence should be a defect or an observation that leads to one.
  - Every defect MUST name the file that owns it and state a specific, implementable fix.
    "Add more detail" is useless. "The ground plane has no normal map applied — Terrain.js is
    requesting the material but never assigning normalMap from the Textures result" is useful.
`

// ---------------------------------------------------------------------------- Judge

phase('Judge')

const critiques = await parallel(SHOTS.map((s) => () =>
  agent(`You are the harshest art director in the games industry, reviewing a frame from
"Slasher Cabin: Some Assembly Required" — a first-person horror game in Three.js/WebGL2.

${CAPTURE}

Your shot id is: ${s.id}

${RUBRIC}

Return STRICT JSON only, no prose outside it:
{
  "shot": "${s.id}",
  "captured": true|false,
  "consoleErrors": ["..."],
  "stats": {"fps":n,"draws":n,"tris":n,"missing":["..."]},
  "scores": {"texture":n,"light":n,"ao":n,"silhouette":n,"depth":n,"material":n,
             "composition":n,"post":n,"color":n,"presence":n},
  "overall": n,
  "whatISee": "2-4 sentences describing the actual image, concretely.",
  "defects": [
    {"severity":"critical|major|minor","file":"world/Forest.js",
     "problem":"what is wrong, as visible in the frame",
     "fix":"the specific implementable change"}
  ]
}
Candidate owning files for this shot: ${s.owners.join(', ')}. Use others if the real cause is
elsewhere.`,
    { label: `judge:${s.id}`, phase: 'Judge', effort: 'high' })
))

const parsed = critiques.filter(Boolean).map((c) => {
  try {
    const m = String(c).match(/\{[\s\S]*\}/)
    return m ? JSON.parse(m[0]) : null
  } catch { return null }
}).filter(Boolean)

const scored = parsed.filter((p) => typeof p.overall === 'number')
const avg = scored.length ? scored.reduce((n, p) => n + p.overall, 0) / scored.length : 0
log(`Round scores: ${scored.map((p) => `${p.shot}=${p.overall}`).join(' ')} | mean ${avg.toFixed(1)}/10`)

// Group defects by the file that owns them, so one agent owns one file (no write conflicts).
const byFile = new Map()
for (const p of parsed) {
  for (const d of p.defects ?? []) {
    if (!d.file) continue
    const key = d.file.replace(/^src\//, '')
    if (!byFile.has(key)) byFile.set(key, [])
    byFile.get(key).push({ ...d, shot: p.shot })
  }
}

// Worst offenders first, and only files with something real to fix.
const targets = [...byFile.entries()]
  .map(([file, defects]) => ({
    file,
    defects,
    weight: defects.reduce((n, d) =>
      n + (d.severity === 'critical' ? 5 : d.severity === 'major' ? 3 : 1), 0),
  }))
  .filter((t) => t.weight >= 3)
  .sort((a, b) => b.weight - a.weight)
  .slice(0, 10)

log(`${byFile.size} files implicated; fixing the ${targets.length} worst.`)

if (!targets.length) {
  return { round: 'clean', avg, critiques: parsed }
}

// ---------------------------------------------------------------------------- Fix

phase('Fix')

const fixes = await parallel(targets.map((t) => () =>
  agent(`You are fixing VISUAL QUALITY defects in exactly one file of a Three.js horror game.

YOUR FILE (the only file you may edit): ${ROOT}/src/${t.file}

An art director reviewed rendered frames and found these defects, which they attribute to your
file. Each was observed in an actual screenshot, so they are real, not hypothetical:

${t.defects.map((d, i) => `${i + 1}. [${d.severity}] (seen in shot "${d.shot}")
   PROBLEM: ${d.problem}
   PROPOSED FIX: ${d.fix}`).join('\n\n')}

Read ${ROOT}/ARCHITECTURE.md and ${ROOT}/ART_DIRECTION.md, then read your file and fix every
defect you agree with. Where you believe the critic is wrong, do not blindly apply the change —
instead say why in your report and add a comment in the code so the next reviewer does not
re-raise it.

RULES: no Math.random(), no console.log (use src/core/Log.js), no allocation in update(),
null-check ctx.systems.get(), keep dispose() correct. NEVER put a backtick inside a GLSL comment
or string — this codebase uses template literals for shaders and one stray backtick silently
breaks the parse hundreds of lines later.

After editing, verify and iterate until all pass:
  node --input-type=module --check < ${ROOT}/src/${t.file}
  curl -s -o /dev/null -w "%{http_code}" ${URL}/src/${t.file}     # must be 200
  cd ${ROOT} && node tools/check.mjs                              # no new FATAL

Then confirm you did not break rendering: navigate the browser to ${URL}/?shot=${t.defects[0].shot}
wait for dataset.shotReady, read console errors, and screenshot. If the frame is now broken or
black, FIX IT before returning.

Return: which defects you fixed and how, which you rejected and why, and confirmation that the
frame still renders.`,
    { label: `fix:${t.file.split('/').pop()}`, phase: 'Fix', effort: 'high' })
))

// ---------------------------------------------------------------------------- Rejudge

phase('Rejudge')

const worstShots = [...new Set(targets.flatMap((t) => t.defects.map((d) => d.shot)))].slice(0, 6)

const rejudged = await parallel(worstShots.map((id) => () =>
  agent(`Re-review one frame after repairs, and report honestly whether it actually improved.

${CAPTURE}

Your shot id is: ${id}

${RUBRIC}

The previous round scored this shot and defects were supposedly fixed. Capture it fresh and judge
it on its own merits — do not assume the fixes worked, and do not inflate the score to reward
effort. If it got WORSE, say so plainly.

Return the same STRICT JSON shape as before:
{"shot":"${id}","captured":bool,"consoleErrors":[],"stats":{},"scores":{},"overall":n,
 "whatISee":"...","defects":[{"severity":"","file":"","problem":"","fix":""}]}`,
    { label: `rejudge:${id}`, phase: 'Rejudge', effort: 'high' })
))

const parsed2 = rejudged.filter(Boolean).map((c) => {
  try { const m = String(c).match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null }
  catch { return null }
}).filter(Boolean)

const scored2 = parsed2.filter((p) => typeof p.overall === 'number')
const avg2 = scored2.length ? scored2.reduce((n, p) => n + p.overall, 0) / scored2.length : 0

const before = new Map(scored.map((p) => [p.shot, p.overall]))
const delta = scored2.map((p) => `${p.shot}: ${before.get(p.shot) ?? '?'} -> ${p.overall}`)
log(`After fixes: ${delta.join(' | ')} | mean ${avg2.toFixed(1)}/10`)

return {
  roundMean: avg,
  afterMean: avg2,
  perShot: delta,
  filesFixed: targets.map((t) => t.file),
  remainingDefects: parsed2.flatMap((p) => p.defects ?? []),
  fixes,
}
