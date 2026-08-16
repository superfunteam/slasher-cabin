# Slasher Cabin: Some Assembly Required — Story Bible & Script

**Owner:** Story agent. Canonical source for `src/story/Script.js`.
**Contract:** All beat ids here are emitted as `story:beat { id }` by `NightManager`. All VO ids
here resolve to `public/audio/vo/<ID>.mp3` and are played via `audio:vo { id, position }` through
`VoiceBank`. All flags here are written to `ctx.state.storyFlags`. Nothing in this document
requires a system that does not exist in `ARCHITECTURE.md`.

**The game must be fully playable, and fully sad, with the VO folder deleted.** Voice is weather.

---

## 1. PREMISE & THEME

A man is building a house in the woods, at night, from a set of wordless instructions, and he is
doing it correctly.

That is the whole game. The comedy is that a slasher-movie monster has a *process* — that he
sorts his hardware, that he reads ahead, that he is annoyed by a missing bracket. The horror is
that the process is *good*. He is not improvising. He is not raving. He measures twice.

Underneath the gag: **this is a story about a man following the last instructions anyone ever
gave him, long past the point where they mean anything.**

Ansel Vik cannot read. His mother, Marit, drew him his life instead. How to tie a boot. How to
bank a stove. How to be silent between the hours of six and nine when his father was home. She
drew in flat, patient, wordless panels — arrows, numbers, a little round-shouldered figure with
two dots for a face — and in the corner of every page she printed a maker's mark, **VIK & SØN**,
because a boy who can't read school should at least be able to believe he has a trade.

The last thing she ever drew him was a house.

He is not building a murder shack. He is rebuilding the house that stood on this shoreline until
1962, when the Wanaka Pines Land Company condemned it and let the volunteer fire brigade burn it
down as a training exercise, because that was cheaper than demolition. Ansel was thirteen. He
stood in the road with the neighbours and watched men in canvas coats practise putting out his
kitchen.

Camp Wanaka Pines is built on top of where he lived. The mess hall is on the garden. The
archery range is the orchard. The counselors' cabins sit across the footprint of the barn.
Nobody there has done anything wrong. Nobody there knows. That is precisely the problem: they
are not villains, they are *tenants*, and they have no idea the landlord came home.

**Theme, stated plainly, once, and never again in the game itself:** grief that has been given a
task will do the task forever. Craft is a way of not stopping. He is patient, careful, and proud,
and every one of those virtues is a symptom.

**The joke we earn and then take away:** for six nights the running gag is *you are always one
part short*. On the seventh night the missing part is a person.

---

## 2. THE SLASHER

**Name:** Ansel Vik. Born 1949. Thirty-five in the summer of 1984. Nobody says his name in the
game. Bev Ranczak comes within one syllable of it on Night Six and stops.

**Silhouette:** 6'6", 280 lb, sloped through the shoulders like a man who has spent his life
ducking through doorframes built for someone else. Canvas coveralls gone black with water.
A lumber strap across the chest. A leather tool roll on the right hip, rolled and tied — never
loose, never rattling. A 28 oz framing hammer with a milled face, carried head-down. No machete.
No blade at all until Night Four, and then only a handsaw, and he hates using it because it is
loud and it dulls.

The manual lives in an oilcloth wallet tucked into the front of his coveralls, against his chest,
where the rain cannot get it.

**The mask.** It is not a mask in the horror sense. It is a portrait.

In his mother's drawings his face was a flat oval with two dots — the way you draw a person when
you are drawing quickly for a child who needs to recognise himself on the page. When the house
burned, the only thing Ansel salvaged from the wreck was the porcelain splash-back panel from
behind the kitchen sink. He cut an oval from it with a tile nipper and drilled two eyes with a
hand brace, and he set the eyes where they were on the page — which is to say, too far apart for
a human skull.

So the mask is cold, off-white, glazed, hairline-cracked, and *wrong*, and Ansel has to tilt his
head to bring a single eyehole onto a target. **That head-tilt is his tell.** It is how the
player recognises him in a photograph on Night Six. It is how Robin describes him, and it is why
nobody believes her, because "he looks at you sideways" is not a description of a man, it is a
description of a bird.

**Why he builds:** because he was told to be quiet and useful, and the instructions did not end,
and no one ever came to check the work.

**He never speaks.** Not a grunt of exertion, not a roar. The loudest sound he makes all game is
the moment on Night Seven when his breath catches. `AudioEngine` should treat his breathing as a
tracked emitter at all times so the absence of a voice is *audible*.

### His one specific, humanising, awful habit

**Before he touches the manual, he wipes his hands on his thighs.** Every single time. Two
strokes, palms flat, unhurried — the way you'd dry your hands before picking up a baby.

He does it when they are wet. He does it when they are muddy. On Night Four he does it when they
are covered in Dale Pruitt, and the animation does not change, and the timing does not change,
and that is the most frightening second in the game, because the priority is not the blood, the
priority is *the paper*.

By Night Seven his hands are split open from a week of cold work and the wipe stops working. He
marks a page. He stops. He looks at the mark for a full second and forty frames. Then he turns
it anyway. It is the only grief the game shows you, and it is over before you are sure it
happened.

**Implementation note:** the wipe is a mandatory 0.9 s lockout on `ui:blueprint-open` from
Night One. Never skippable. It is a design cost the player pays ninety times so that one instance
of it can pay off.

---

## 3. THE MANUAL AS NARRATOR

The manual is the only character in this game with a personality, a sense of humour, and an
opinion. It has no words. It has an *attitude*, expressed entirely through:

- **what it bothers to draw** (and what it assumes you already know),
- **the mascot** — the round-shouldered little man with the flat face and the hammer,
- **the warnings** — a circled panel, a red diagonal, a small exclamation,
- **the article numbers**, which are the only "text" and which are *not* random,
- **the linework itself.**

One word appears in the entire game: the cover reads **HJEM**. The player will parse it as a
flat-pack product name, the way you'd parse KALLAX or BILLY. It is not a product name. It is the
only word Marit ever taught Ansel to read.

### The linework tell (the real narrative device)

There are two hands in this manual and the player is not told this.

- **Marit's hand:** single confident stroke, closed corners, even weight, mascot always drawn
  with rounded shoulders and a slight forward lean, as if listening.
- **Ansel's hand:** doubled-back lines, over-corrected corners, visible erasure ghosts, mascot
  drawn *taller*, shoulders square, no lean.

The manual does not "get darker." **Ansel starts drawing the pages he needs it to say.** By
Night Five roughly a third of the panels are his. By Night Six, most. That is the actual arc, and
`Blueprint.js` should expose it as a per-panel `authorship: 'marit' | 'ansel'` field driving line
jitter, stroke doubling, and eraser ghosting in the procedural diagram generator.

### The seven-stage evolution

**Night 1 — HELPFUL.** Warm, over-explains, delighted with you.
> *Panel 1.1:* the mascot waving, both hands, from the corner of the page.
> *Panel 1.4:* a bolt going into a hole. Then the same bolt, larger. Then the same bolt again
> with a magnifying glass over it, in case you missed the bolt.
> *Panel 1.7:* the mascot standing on the finished pier, arms up, one small drawn sparkle.

**Night 2 — PEDANTIC.** It has decided you're competent and now it's fussy.
> *Panel 2.3:* a bracket at 90°, ticked. The same bracket at 88°, crossed out in red. The same
> bracket at 89.5°, **also** crossed out in red.
> *Panel 2.6:* a hand tightening a bolt. An arrow labelled with a small dial. A second panel
> showing the same hand, over-tightened, and the mascot with one flat line for a mouth.
> The mascot has never had a mouth before. He does not have one again for three nights.

**Night 3 — IMPATIENT.** Steps get combined. It skips things.
> *Panel 3.2:* eleven sub-assemblies collapsed into one drawing with fourteen arrows and no
> intermediate states. Good luck.
> *Panel 3.5:* an entire step rendered as a single downward arrow and the number **×6**.
> *Panel 3.8:* the mascot, arms folded, tapping one foot — drawn with motion ticks. It is
> waiting for you. It is the first time the manual is a *presence* and not a document.

**Night 4 — KNOWING.** It begins illustrating things it should not know about.
> *Panel 4.1:* the hinge you need, drawn in isolation. Then drawn *in situ* — screwed to the
> camp boathouse door. The manual knows where the camp is.
> *Panel 4.6:* a cone of light on the ground. The mascot outside the cone. A dotted path.
> This is the first panel that is about *them* and not about the house.
> *Panel 4.9 (Ansel's hand, and the player will not consciously notice):* the mascot standing
> over a horizontal shape. The shape is not a joist. It has shoes.

**Night 5 — COMPLICIT.** It stops pretending this is only carpentry.
> *Panel 5.1:* the standard flat-pack warning icon — **THIS STEP REQUIRES TWO PERSONS** — two
> mascots, one at each end of a wall panel. Both drawn in Marit's hand. Both drawn twenty-two
> years ago.
> *Panel 5.4:* the second mascot, erased. Redrawn. Erased. Redrawn smaller. The eraser ghosts
> are visible under the final line. Three attempts. This panel has no arrows, no numbers, and
> no instruction. It should not be in a manual at all.
> *Panel 5.7:* a counterweight diagram. The counterweight is a rectangle with a number on it.
> The number is a weight in kilograms. It is 71 kg.

**Night 6 — WRONG.** Not sinister-wrong. *Broken*-wrong. Which is worse.
> *Panel 6.2:* step 14 before step 9. Step 9 does not appear.
> *Panel 6.5:* an article number that does not exist and cannot be found — **0000-000** — with
> a confident arrow pointing at an empty slot. The player will search for twenty minutes. It
> is not out there.
> *Panel 6.8:* a wall elevation drawn in perfect Marit line — a kitchen, a window over a sink,
> pencil marks on a doorframe at four ascending heights — and then, drawn over the top of it in
> Ansel's scratched hand, a *bunk bed*. He is trying to make his mother's house fit a camp.
> It doesn't. He erases the bunk. The ghost stays.
> *Panel 6.9:* the mascot, alone, in the middle of an otherwise empty page. Not doing anything.

**Night 7 — GONE.** `BlueprintUI` opens to a blank spread. The wipe animation still plays.
> There is exactly one mark on the final page: a **dotted outline** of a small seated figure,
> in a chair, at a table. Child-sized. Drawn in Marit's hand, in 1962, on the last page she
> finished.
> Above it, the flat-pack convention every player knows on sight: the parts-list bracket, and
> inside the bracket, nothing.
> **Some assembly required.**

---

## 4. THE SEVEN NIGHTS

Escalation runs on three independent curves: **build complexity** (parts/slots/tolerance),
**camper density** (`Campers` count and patrol overlap), and **tone**. They are deliberately
out of phase — Night 4 spikes tone before it spikes density, Night 6 drops density to almost
nothing and is the most frightening night in the game.

---

### NIGHT ONE — FOUNDATION (A)
*Beat id:* `n1_thumbs_up` · *Flag:* `sawIntroPanel`

- **Build:** six stone piers, six sill beams, twenty-four lag bolts. Two-part join, generous
  snap tolerance, torque is forgiving.
- **Missing:** one shim. Pier D sits 11 mm low. The manual's fix panel is a rectangle with an
  arrow. It does not care what the rectangle is.
- **What goes wrong:** nothing. Genuinely nothing. He gets it right.
- **New mechanic:** carry (`build:pickup`/`build:drop`), place (`build:place`), torque-hold, and
  the creak (`build:creak`) as pure comedy — a wrong join groans like a bad chair and a loon
  answers it from across the water.
- **Camper density:** one. Dale Pruitt, four hundred metres off, drunk, singing half a song and
  giving up on it twice.
- **Story beat:** the player finds the shim themselves — a 1961 Minnesota licence plate, folded
  in three, wedged under a stump. It fits perfectly. It has always been the shim. It was under
  the old house too.
- **Emotional turn:** competence as comedy. The player laughs at a monster doing homework.
- **Closing image:** rain on six perfectly level piers, a spirit level's bubble dead centre, and
  the manual's last panel — the little masked man on the foundation with both arms up.

---

### NIGHT TWO — UPRIGHTS (B ×4), SUPPORT WHILE FIXING
*Beat id:* `n2_robin_hears` · *Flag:* `robinSuspicious`

- **Build:** four wall frames, corner brackets, diagonal bracing. Order matters now — brace
  before you release.
- **Missing:** bracket **H**. Four needed, three in the pile. The fourth is a gag: the manual's
  parts-list panel shows four, and the player will count them three times.
- **What goes wrong:** the third wall goes up out of plumb by two degrees. It stands. It creaks
  in wind. `Weather` gusts now trigger `build:creak` on any join with `correct:false`.
- **New mechanic:** noise and light. `NoiseSystem` propagation, camper flashlight cones, crouch,
  line-of-sight break. First `player:spotted` risk.
- **Camper density:** three (Dale, Marg, Coop) unloading a truck by the road.
- **Story beat:** Robin Osei-Hall, alone at the canoe rack, hears a mallet. Four strikes, even,
  spaced. She stops moving. `ROB_HEAR_01`.
- **Emotional turn:** the joke gets a witness.
- **Closing image:** her torch beam crawls over the frame at eighty metres, holds on it for a
  second and a half, and moves on. She does not understand what she's looking at, because it is
  a house, and there is not supposed to be a house.

---

### NIGHT THREE — DO NOT OVERTIGHTEN
*Beat id:* `n3_not_believed` · *Flag:* `robinDismissed`

- **Build:** roof trusses. Six identical assemblies, each requiring a prop-and-hold while the
  ridge is pinned.
- **Missing:** nothing is missing. The **ridge beam is 340 mm too long**. You must cut it. The
  handsaw is in the tool roll and has been the whole time.
- **What goes wrong:** cutting is the loudest sustained noise in the game — a continuous
  `noise:emit` with `kind:'saw'`, radius 90 m, that you must break into passes between patrols.
  The comedy: you cannot rush a saw. The monster is hostage to the physics of a saw.
- **New mechanic:** sustained-noise budgeting; `suspicion` becomes a persistent camp-wide value
  that carries into Night Four.
- **Camper density:** four. Bev arrives.
- **Story beat:** Robin tells Bev about the mallet. Bev tells her the sound carries across the
  water from the state campground, six kilometres, happens every year. Bev is not being
  dismissive. Bev is being *correct about a thing that is usually true.* `BEV_ARG_02`.
- **Emotional turn:** the first cruelty in the script is committed by the campers, gently, to
  each other.
- **Closing image:** the ember of Bev's cigarette at the treeline, held, unmoving, for eleven
  seconds — a person standing in the dark deciding whether to walk out and look. She doesn't.

---

### NIGHT FOUR — IF PARTS ARE MISSING, DO NOT RETURN TO STORE
*Beat id:* `n4_dale` · *Flag:* `firstBlood`

- **Build:** subfloor, then the door. The door is the first piece that is obviously *domestic*.
- **Missing:** hinges. There are no hinges in the woods. There are three good brass hinges on
  the camp boathouse door, ninety metres inside the lit perimeter.
- **What goes wrong:** Dale Pruitt walks up the fire road to piss and finds a house that was not
  there in June. He is not scared. He is *confused*, and he says "…the hell is this, chief" out
  loud to nobody, and he reaches out and knocks on it, twice, politely, the way you knock on a
  thing to see if it's real.
- **New mechanic:** infiltration into a lit, occupied space. Stealing an object the campers will
  notice is gone. Consequence persists — the boathouse door hangs open for the rest of the game.
- **Camper density:** five, but concentrated. The forest is emptier than it has ever been.
- **Story beat:** the first kill, off-camera, in a single hard cut to black with no music sting
  and no scream — only the sound of a hammer set down carefully on wood.
- **Emotional turn:** **the comedy dies here and does not fully return.** Nights 1–3 have jokes
  in the ambient VO; Night 4 onward, the campers stop being funny on purpose and start being
  funny by accident, which is unbearable.
- **Closing image:** Dale's torch on the ground, still lit, still rolling in a slow quarter-arc,
  its beam sweeping across a wall that is *plumb, square and true.*

---

### NIGHT FIVE — THIS STEP REQUIRES TWO PERSONS
*Beat id:* `n5_two_persons` · *Flag:* `sawSecondFigure`

- **Build:** the long north wall panel, 4.8 m, mass 71 kg. Lift, walk, seat, pin.
- **Missing:** **a second person.** The panel physically cannot be seated by one man; `Physics`
  refuses the placement and the wall slides. The manual's warning icon shows two mascots.
- **What goes wrong:** the player must improvise a counterweight and a lever from the world —
  Dale's canoe, a rope, a stump, a ladder. The solution is ugly. It is the first thing Ansel
  builds that his mother did not draw.
- **New mechanic:** rigging. Multi-object physical assembly with no snap points and no correct
  answer, only a working one. `build:place` fires with `correct:true` for a join the manual never
  specified — the only time in the game.
- **Camper density:** five, actively searching in pairs. Nobody goes anywhere alone after Dale.
- **Story beat:** Panel 5.4. The erased-and-redrawn second figure. The player will open the
  manual to check a measurement, land on it, and there will be no measurement on the page.
- **Emotional turn:** loneliness, delivered as a UI element. This is the night the game stops
  being about a monster.
- **Closing image:** the wall stands. Ansel puts one hand flat against it and leaves it there
  longer than the animation needs. Rain. The other end of the wall is held up by a canoe.

---

### NIGHT SIX — SOLD SEPARATELY
*Beat id:* `n6_robin_inside` · *Flag:* `robinSaw`, `bevRemembered`

- **Build:** roof battens, shingles, and the interior — a sink, a stove flue, a doorframe.
- **Missing:** article **0000-000**. It is not in the world. It has never been in the world.
  The game will let you look for it for as long as you like.
- **What goes wrong:** the manual is broken. Steps out of order, a missing step 9, a wall
  elevation that contradicts the floor plan. **The only reliable reference is the ground:** the
  old foundation stones of the Vik house are still under the site, and the new house lines up
  with them exactly. To finish the night the player must stop reading and start *remembering* —
  a mechanic that is also a thesis.
- **New mechanic:** blueprint unreliability. `Blueprint.js` serves deliberately contradictory
  panels; correctness is validated against `CabinSite` ruin anchors instead.
- **Camper density:** **two.** The camp has called the county. Most of them are at the road,
  waiting on headlights that take four hours to arrive. The woods are the emptiest they have
  ever been and it is the worst night of the game.
- **Story beat, part one:** Robin finds the site. She goes inside. She is not attacked, because
  Ansel is on the roof and she is standing in his mother's kitchen and he does not know what to
  do about that. She sees the sink with a rectangle of missing porcelain behind it. She sees the
  doorframe: four pencil marks, ascending, dated in a woman's handwriting, 1953 to 1957. She
  puts her hand flat on the top one. It is above her head.
- **Story beat, part two:** Bev, at the road, in the headlights of her own truck, says the thing
  she has been circling for three nights — that there was a family on this shore, that the boy
  was big and quiet and used to fix the dock for nothing, that his name was Ansel V— and she
  stops, because saying it makes it a real person, and she has spent twenty-two years not doing
  that. `BEV_LATE_04`.
- **Emotional turn:** the audience knows everything. Ansel knows nothing. The gap is the horror.
- **Closing image:** Robin's hand on the doorframe, at the height of a boy's head in 1957, and
  a shadow across the window that does not move.

---

### NIGHT SEVEN — SOME ASSEMBLY REQUIRED
*Beat id:* `n7_final` · *Flag:* `ending_<a|b|c>`

- **Build:** nothing structural remains. The house is finished. It is beautiful. It is, by any
  standard the game has taught you, **perfect work.**
- **Missing:** see §8.
- **New mechanic:** everything is taken away. No HUD, no reticle, no prompts, no objective
  marker, no creak feedback. `settings.subtitles` still works; nothing speaks.
- **Camper density:** one. Then none.
- **Closing image:** see §8.

---

## 5. THE CAMPERS

Six people who arrived a week early to open a summer camp, which is a genuinely nice thing to
volunteer for. None of them are stupid. None of them are cruel. Two of them are in love in a
low-stakes, slightly embarrassing way. All of them are good at their jobs. The player should be
actively annoyed when the game requires them to be hurt.

**Casting note for `tools/generate-voices.mjs`:** six distinct ElevenLabs voices, all pitched
*young and tired* except Bev. No "horror movie" delivery, ever. If a line sounds like a line, cut
it and re-record it flatter.

---

**ROBIN OSEI-HALL — 19 — Arts & Crafts.**
Second summer. Grew up in her father's boatyard in Duluth; she has heard ten thousand hours of
tools and she knows the difference between a woodpecker and a mallet the way you know your own
name. That is her tragedy: she is right for a technical reason nobody else can evaluate.
*Verbal tic:* restarts her own sentences — "Okay so — okay, no, listen." Never finishes the
first attempt.
*Relationship:* older-sister energy toward Teddy; she checks he's eaten.
**She is the one who notices, on Night Two, and is not believed.** She is also the only one who
gets inside the house and understands what it is.

**DALE PRUITT — 27 — Maintenance.**
Sixth summer. Fixes everything, resents nothing, drinks a little more than he'd like you to know.
Calls everyone *chief* or *champ* and trails off mid-thought with "…anyway." Kind in a way that
costs him something. He could corroborate Robin on Night Three and doesn't, because
corroborating means a report, and a report means the county, and the county means his job.
*Relationship:* Robin's reluctant almost-ally. Their unfinished conversation is the saddest
thing in the VO bank.
*Dies Night Four, politely, mid-sentence, having knocked first.*

**MARGUERITE "MARG" TOTH — 21 — Waterfront Director.**
Third summer. Runs the dock like a small navy. Counts out loud — "one, two, and — okay" — and
narrates her own logistics because it's how she thinks. Competent, warm, a little bossy, and the
first to organise a proper search on Night Five instead of a panic.
*Relationship:* with Coop, three months, hasn't told her mother.

**COOPER "COOP" VANCE — 20 — Sports & Rec.**
Second summer. Loud, plays four chords badly, turns everything into a bit and then apologises for
the bit thirty seconds later — "sorry, that was — yeah, sorry." Write him kind. His bits are how
he checks whether people are okay. On Night Six he stops doing bits and it is genuinely alarming.
*Relationship:* Marg; and he has appointed himself Teddy's guy.

**TEDDY NAKAGAWA — 16 — Counselor-in-Training.**
First summer away from home. Says *sorry* as punctuation. Asks permission to do things he has
already been told to do. Homesick in the specific 16-year-old way where you'd rather die than
mention it, and he mentions it exactly once, to Robin, at 2 a.m., and then changes the subject.
*Relationship:* orbits Coop; is looked after by Robin.

**BEVERLY "BEV" RANCZAK — 58 — Camp Director.**
Here since 1971. Chain-smokes Winstons. Speaks in fragments with the articles removed — "Get the
tarps. Both of 'em. Now." Loves this place with a fierceness she would never say out loud.
*Relationship:* everyone's boss; Dale's oldest friend on site.
**She is the living link.** She bought a camp that came with a burned foundation and a story she
never asked about. On Night Six she remembers the family's name and it is the closest the game
comes to explaining anything.

---

## 6. AMBIENT VO SCRIPT

**Rules.** Heard at distance, in 3D, through trees, through rain, usually half-caught. Never a
narrator. Never plot-critical — every line is deniable. Most under twelve words. `VoiceBank`
applies distance low-pass and occlusion; **write for the words that survive the filter.**

**Voice settings columns:** `S` = stability, `Sim` = similarity_boost, `St` = style. Low
stability = more variance, more human. Nothing above 0.60 stability except Bev.

### 6.1 Idle chatter — banal, overlapping, funny by accident

| ID | Speaker | Line | State | Delivery | S / Sim / St |
|---|---|---|---|---|---|
| `MRG_IDLE_01` | Marg | "One, two — and that's the last of the tarps." | content | to herself, counting | .45 / .80 / .20 |
| `MRG_IDLE_02` | Marg | "Whoever loaded this truck hates me personally." | wry | half-laugh at the end | .40 / .80 / .30 |
| `COO_IDLE_01` | Coop | "I'm just saying, powdered eggs are a *choice*." | jokey | mid-bit, no punchline | .35 / .78 / .40 |
| `COO_IDLE_02` | Coop | "Sorry, that was — yeah. Sorry." | sheepish | apologising to nobody | .40 / .78 / .35 |
| `COO_IDLE_03` | Coop | "Does this look level to you? Don't lie." | casual | genuinely asking | .45 / .78 / .30 |
| `DAL_IDLE_01` | Dale | "Third year that pump's gone out. Anyway." | tired | trails off, no ending | .50 / .82 / .20 |
| `DAL_IDLE_02` | Dale | "You want it done or you want it done right, champ." | dry | old joke, said flat | .50 / .82 / .25 |
| `DAL_IDLE_03` | Dale | "Ah — nope. That's a hornet situation." | alarmed-mild | retreating, unbothered | .40 / .80 / .35 |
| `ROB_IDLE_01` | Robin | "Okay so — okay, no. Start over." | focused | correcting herself | .40 / .80 / .30 |
| `ROB_IDLE_02` | Robin | "Teddy. Teddy. Did you eat? Don't lie to me." | warm | sisterly, insistent | .40 / .80 / .35 |
| `TED_IDLE_01` | Teddy | "Sorry — is this the right shed? Sorry." | anxious | over-polite | .35 / .78 / .40 |
| `TED_IDLE_02` | Teddy | "My mom packed like nine cans of soup." | shy | small laugh at himself | .35 / .78 / .35 |
| `BEV_IDLE_01` | Bev | "Rain by Thursday. Get the canvas up." | brisk | no articles, no warmth | .60 / .85 / .15 |
| `BEV_IDLE_02` | Bev | "Twenty-two summers. Never once on schedule." | fond | almost affectionate | .55 / .85 / .20 |

### 6.2 Calling out to each other — across distance, the loudest lines in the game

| ID | Speaker | Line | State | Delivery | S / Sim / St |
|---|---|---|---|---|---|
| `MRG_CALL_01` | Marg | "Coop! Other end! Other *other* end!" | busy | shouted, laughing | .30 / .78 / .45 |
| `COO_CALL_01` | Coop | "Yeah — hang on — yeah!" | busy | half-shouted, muffled | .30 / .78 / .40 |
| `ROB_CALL_01` | Robin | "Dale? You up by the shed?" | neutral | carrying voice, unworried | .40 / .80 / .30 |
| `DAL_CALL_01` | Dale | "Yeah, chief, I'm here!" | neutral | shouted from far off | .35 / .82 / .35 |
| `BEV_CALL_01` | Bev | "Everybody. Mess hall. Ten minutes." | commanding | flat, absolute | .60 / .85 / .15 |
| `TED_CALL_01` | Teddy | "Coop? Was that you?" | uncertain | too quiet to carry | .30 / .78 / .40 |
| `MRG_CALL_02` | Marg | "Say again? You're breaking up in the trees!" | neutral | cupped hands | .35 / .80 / .40 |
| `ROB_CALL_02` | Robin | "Nothing! Never mind!" | resigned | giving up on being heard | .40 / .80 / .35 |

### 6.3 Campfire stories — Nights 1–3 only

| ID | Speaker | Line | State | Delivery | S / Sim / St |
|---|---|---|---|---|---|
| `COO_FIRE_01` | Coop | "…and *that's* why we don't swim past the raft." | performative | doing a voice, badly | .30 / .78 / .55 |
| `MRG_FIRE_01` | Marg | "That's not true. None of that is true." | amused | interrupting | .40 / .80 / .35 |
| `COO_FIRE_02` | Coop | "It's *emotionally* true, Marguerite." | jokey | mock-wounded | .30 / .78 / .50 |
| `DAL_FIRE_01` | Dale | "There was a house out on the point. Before." | flat | throwaway, no weight | .55 / .82 / .15 |
| `MRG_FIRE_02` | Marg | "Before what?" | curious | genuine, small | .45 / .80 / .30 |
| `DAL_FIRE_02` | Dale | "Before the camp. Burned, I think. Anyway." | disinterested | he does not care yet | .55 / .82 / .15 |
| `TED_FIRE_01` | Teddy | "Is it okay if I sit here? Sorry." | shy | barely audible | .35 / .78 / .40 |
| `ROB_FIRE_01` | Robin | "Sit down, Teddy. God." | warm | laughing at him kindly | .40 / .80 / .35 |

### 6.4 Arguments — small, domestic, real

| ID | Speaker | Line | State | Delivery | S / Sim / St |
|---|---|---|---|---|---|
| `MRG_ARG_01` | Marg | "I *asked* you to do it before dark." | irritated | tired, not angry | .40 / .80 / .40 |
| `COO_ARG_01` | Coop | "And I said I would, and I'm doing it." | defensive | flat, hurt | .35 / .78 / .40 |
| `BEV_ARG_01` | Bev | "Not tonight. Both of you." | final | zero volume, total authority | .60 / .85 / .15 |
| `BEV_ARG_02` | Bev | "Sound carries over the water. Happens every year." | dismissive | kind, and wrong | .55 / .85 / .20 |
| `ROB_ARG_01` | Robin | "It wasn't the water. It was — okay. Fine." | frustrated | giving up mid-sentence | .35 / .80 / .45 |
| `DAL_ARG_01` | Dale | "If we call it in, it's a report. Anyway." | evasive | won't meet her eye | .50 / .82 / .25 |
| `ROB_ARG_02` | Robin | "So that's a no. That's a no, Dale." | quiet-angry | very controlled | .35 / .80 / .45 |
| `TED_ARG_01` | Teddy | "Are you guys — sorry. Never mind." | uncomfortable | backing out of a room | .30 / .78 / .40 |

### 6.5 "I heard something"

| ID | Speaker | Line | State | Delivery | S / Sim / St |
|---|---|---|---|---|---|
| `ROB_HEAR_01` | Robin | "Shh — shh. There. That." | alert | dead still, whispered | .30 / .78 / .50 |
| `ROB_HEAR_02` | Robin | "That's a mallet. That's somebody driving a stake." | certain | technical, unsettling | .40 / .80 / .35 |
| `MRG_HEAR_01` | Marg | "Okay, I heard that one. I heard that." | unnerved | conceding, not scared | .35 / .80 / .40 |
| `COO_HEAR_01` | Coop | "Deer. That's deer. That's a deer thing." | reassuring | reassuring himself | .30 / .78 / .45 |
| `DAL_HEAR_01` | Dale | "Huh." | neutral | one syllable, thoughtful | .55 / .82 / .20 |
| `TED_HEAR_01` | Teddy | "Something moved. Over — there. Sorry." | frightened | pointing, small voice | .25 / .78 / .55 |
| `BEV_HEAR_01` | Bev | "Quiet. Everybody. Quiet." | hard | drops to nothing | .55 / .85 / .25 |
| `MRG_HEAR_02` | Marg | "It stopped. Why did it stop." | tense | not a question | .30 / .80 / .50 |
| `ROB_HEAR_03` | Robin | "Four hits. Even. Nothing hits four times even." | insistent | building an argument | .35 / .80 / .45 |
| `COO_HEAR_02` | Coop | "Okay that's — okay, that's not funny now." | rattled | bit collapsing in real time | .30 / .78 / .50 |

### 6.6 Searching

| ID | Speaker | Line | State | Delivery | S / Sim / St |
|---|---|---|---|---|---|
| `MRG_SRCH_01` | Marg | "Pairs. Nobody goes out alone, I mean it." | organised | commanding, steady | .45 / .80 / .30 |
| `MRG_SRCH_02` | Marg | "One, two — Robin, that's three, where's Coop?" | counting | rising | .35 / .80 / .40 |
| `COO_SRCH_01` | Coop | "Dale? Buddy? You messing with us?" | hopeful | wants to be pranked | .30 / .78 / .45 |
| `ROB_SRCH_01` | Robin | "Check the boathouse. The door's open." | focused | flat, professional | .40 / .80 / .35 |
| `BEV_SRCH_01` | Bev | "Torches low. Watch the roots." | practical | still doing her job | .55 / .85 / .20 |
| `TED_SRCH_01` | Teddy | "How far do we go? Sorry — how far?" | scared | asking permission again | .25 / .78 / .55 |
| `COO_SRCH_02` | Coop | "Dale! Come on, man!" | strained | shouting into trees | .25 / .78 / .55 |
| `ROB_SRCH_02` | Robin | "Stop. Everybody stop. Listen." | tight | commanding for the first time | .30 / .80 / .50 |
| `MRG_SRCH_03` | Marg | "We've been past that stump twice." | worried | quiet realisation | .35 / .80 / .40 |
| `BEV_SRCH_02` | Bev | "Back to the road. Now. Move." | urgent | no fear in it, only speed | .55 / .85 / .25 |

### 6.7 False alarms — the comedy that stops being comedy

| ID | Speaker | Line | State | Delivery | S / Sim / St |
|---|---|---|---|---|---|
| `COO_FALSE_01` | Coop | "AH — okay. Okay. Raccoon. It's a raccoon." | startled | genuine fright, fast recovery | .25 / .78 / .60 |
| `MRG_FALSE_01` | Marg | "You screamed. You actually screamed." | teasing | relieved laughing | .35 / .80 / .45 |
| `TED_FALSE_01` | Teddy | "Sorry! Sorry, that was me, sorry." | embarrassed | mortified | .30 / .78 / .45 |
| `ROB_FALSE_01` | Robin | "It's fine. It's fine. Everyone breathe." | steadying | doesn't believe it | .40 / .80 / .35 |
| `COO_FALSE_02` | Coop | "See? Nothing. Told you. Nothing." | hollow | the bit isn't working | .30 / .78 / .50 |
| `DAL_FALSE_01` | Dale | "Little guy's got more right to be here than us." | fond | about the raccoon | .50 / .82 / .25 |

### 6.8 Finding evidence

| ID | Speaker | Line | State | Delivery | S / Sim / St |
|---|---|---|---|---|---|
| `ROB_EVID_01` | Robin | "These are sawdust. In June. From what?" | analytical | crouched, close | .40 / .80 / .35 |
| `MRG_EVID_01` | Marg | "The hinges are gone. Off the *door*." | baffled | not yet scared | .35 / .80 / .40 |
| `COO_EVID_01` | Coop | "Somebody took the hinges. Who takes hinges." | uneasy | trying to make it funny | .30 / .78 / .45 |
| `ROB_EVID_02` | Robin | "There's a path here. Somebody's worn a path." | cold | the moment it becomes real | .35 / .80 / .45 |
| `BEV_EVID_01` | Bev | "That's not camp lumber. That's milled." | grim | recognising work | .55 / .85 / .25 |
| `TED_EVID_01` | Teddy | "It's Dale's. That's Dale's torch. That's his." | breaking | voice going thin | .20 / .78 / .65 |
| `MRG_EVID_02` | Marg | "Don't touch it. Don't — Teddy, don't touch it." | urgent | protective | .25 / .80 / .55 |
| `ROB_EVID_03` | Robin | "Somebody's *building* something out there." | horrified | saying it out loud at last | .30 / .80 / .50 |

### 6.9 Genuine fear

| ID | Speaker | Line | State | Delivery | S / Sim / St |
|---|---|---|---|---|---|
| `TED_FEAR_01` | Teddy | "I want to go home. I'm sorry. I want to go home." | breaking | whispered, no performance | .20 / .78 / .65 |
| `ROB_FEAR_01` | Robin | "Okay. Okay. Okay okay okay." | managing | self-soothing, fast | .25 / .80 / .55 |
| `COO_FEAR_01` | Coop | "Marg. Marg, look at me. Look at me." | frightened | trying to hold her together | .25 / .78 / .55 |
| `MRG_FEAR_01` | Marg | "I counted five. There were five of us." | numb | flat, wrong-sounding | .35 / .80 / .40 |
| `BEV_FEAR_01` | Bev | "Twenty-two years. Never. Not once." | shaken | first crack in her | .45 / .85 / .35 |
| `ROB_FEAR_02` | Robin | "He looks at you sideways. Like a bird." | disturbed | trying to describe it | .30 / .80 / .50 |
| `COO_FEAR_02` | Coop | "I'm not — I can't do a joke. I don't have one." | lost | genuinely undone | .25 / .78 / .55 |
| `TED_FEAR_02` | Teddy | "Is he still there? Is he still — " | terrified | cut off by his own breath | .20 / .78 / .70 |
| `MRG_FEAR_02` | Marg | "Run to the road. Don't stop at the truck." | resolute | commander to the last | .30 / .80 / .50 |
| `ROB_FEAR_03` | Robin | "It's not a shack. It's a *house*." | stunned | the realisation, quiet | .35 / .80 / .45 |

### 6.10 Very late game — Nights 6 and 7 only

| ID | Speaker | Line | State | Delivery | S / Sim / St |
|---|---|---|---|---|---|
| `BEV_LATE_01` | Bev | "County's four hours out. Four hours." | grim | reporting a fact | .55 / .85 / .25 |
| `BEV_LATE_02` | Bev | "There was a family on this shore. Before us." | quiet | dawning | .50 / .85 / .30 |
| `BEV_LATE_03` | Bev | "Boy was big. Quiet. Fixed the dock for nothing." | soft | remembering a kindness | .50 / .85 / .30 |
| `BEV_LATE_04` | Bev | "His name was Ansel V—" | stopped | stops herself dead | .45 / .85 / .35 |
| `ROB_LATE_01` | Robin | "There's marks on the door. Pencil. Somebody's kid." | shaken | inside the house, whispering | .30 / .80 / .50 |
| `ROB_LATE_02` | Robin | "Fifty-three. Fifty-five. Fifty-seven." | hollow | reading dates aloud | .35 / .80 / .40 |
| `ROB_LATE_03` | Robin | "Oh. Oh, you poor — " | pitying | cut off, and never finished | .25 / .80 / .60 |
| `TED_LATE_01` | Teddy | "The buses come at nine. They're gonna come at nine." | dazed | shock, repeating | .25 / .78 / .55 |

**Total: 90 lines.** Bank size is deliberately small; `VoiceBank` should aggressively vary
distance, occlusion, pitch (±3 %) and delay so no line is ever heard "the same way twice."

---

## 7. ENVIRONMENTAL STORYTELLING — 20 OBJECTS

Each is placed by `Props.js` or `CabinSite.js` and is inert — no pickup prompt, no lore entry, no
audio sting. If a player never notices one, that is fine. That is the point.

1. **The 1961 licence plate shim** (Night 1, under a stump 30 m east). *Implies:* somebody
   levelled something here before. *Replay:* it was under the original house. He kept it.
2. **A ring of foundation stones**, black at the edges, visible only when the player's lantern
   rakes across at a low angle (build site). *Implies:* a fire. *Replay:* he is building exactly
   on the footprint. Every pier lands on an old one.
3. **A porcelain sink**, cracked, propped against a birch 60 m from the site with a
   rectangular section missing from its splash-back. *Replay:* that rectangle is on his face.
4. **A child's boot**, size 3, hung on a nail at head height on a tree by the fire road. Not
   dropped — *hung*. Deliberately. Years ago. *Replay:* it is his own.
5. **A tool roll**, spread flat under an oilcloth, tools laid in descending size, each in its
   own stitched pocket, a gap where the handsaw goes. *Implies:* order. *Replay:* one pocket is
   too small for anything he owns — a child's hammer used to live there.
6. **Fifty-one wooden survey stakes**, driven in a perfect grid across the site, each numbered in
   carpenter's pencil. *Implies:* planning. *Replay:* he surveyed this before the campers came.
   The numbering starts at 1953.
7. **A stack of ruined manual pages** in a tin under a rock, weighted, dry. Twelve attempts at
   the same panel, each worse than the last. *Replay:* he has been trying to draw his mother's
   hand and failing since long before Night One.
8. **A carpenter's pencil sharpened to 8 mm**, replaced every night with an identical one.
   *Implies:* nothing on first look. *Replay:* he has been here for weeks.
9. **The Wanaka Pines Land Company survey marker**, 1962, brass, in the ground at the property
   line, polished bright by something rubbing it. *Replay:* he cleans it. Every night.
10. **Bev's ashtray on the office porch** — a hubcap, forty butts, all crushed the same
    direction. *Implies:* a woman who sits in the same chair every night. *Replay:* the chair
    faces the point where the house used to be.
11. **The boathouse door**, hinges gone from Night Four onward, propped with an oar, never fixed.
    *Implies:* the camp is losing.
12. **Dale's torch**, still lit on Night Five and Six, battery dying, beam browning. On Night
    Seven it is off, and it has been moved eleven metres — *toward* the house, and set down neatly.
13. **A canoe**, upside down, one gunwale crushed under a wall panel. *Implies:* improvisation.
    *Replay:* it's Dale's canoe. He is holding up the wall.
14. **A hand-drawn floor plan carved into a rock face** near the ridge, weathered, at least a
    decade old. *Replay:* he has drawn this house in a dozen places over twenty years and never
    built it until now.
15. **A rusted swing seat** hanging from one chain in a tree that is now inside the archery
    range. *Implies:* somebody's yard. *Replay:* his.
16. **A camp photo board** in the mess hall — twenty-two summers of group photos. In 1971, at the
    back edge of the frame, out of focus, a very large man at the treeline with his head tilted.
17. **A grave**, unmarked, small, well-kept, forty metres uphill of the site, with the grass cut
    by hand. *Implies:* somebody buried something. *Replay:* Marit. He mows it.
18. **A single set of pencil marks on a birch trunk** — four horizontal notches at 91, 108, 124
    and 141 cm. Matches the doorframe inside the finished house exactly.
19. **A folded blanket and a tin cup** on a stump at the site, arranged for a second person.
    Dry, brushed off, refreshed nightly. Nobody ever sits there.
20. **Two chairs**, hand-made, identical, inside the finished house on Night Seven. One is
    adult-sized. One is not.

---

## 8. THE ENDING

The house is finished at 03:40 on the seventh night. The rain has stopped. It is the first time
in the game the world is quiet.

The player walks the interior with no HUD. Every surface is correct. The floor does not creak
anywhere — the player has spent seven nights learning what a creak means, and its total absence
is more frightening than any sound the game has made. There is a sink with a window over it. A
stove flue. A doorframe with four pencil marks. A table. **Two chairs.**

The player opens the manual. The wipe animation plays. The pages are blank.

On the last page: a dotted outline of a small figure, seated, at a table. Child-sized. The
parts-list bracket beside it, and inside the bracket, an empty space where an article number
should be.

The game gives the player exactly one interaction verb: **place**.

### Ending A — "RETURN TO STORE" (the monstrous ending)

The player goes and gets Robin. She is at the treeline; she has been coming back every night.
The game lets you take her inside. It is not a chase and there is no struggle scene — the screen
does not cut away, and she says `ROB_LATE_03` and does not finish it.

Then the player opens the manual to confirm the step, and the panel updates in real time, in
Ansel's scratched, doubled hand — and the manual draws a **red diagonal across it.**

The only red mark ever aimed at the player. The only judgement the manual has ever passed. The
mascot is drawn with its arms at its sides. Marit never told him to do this. He has been
extrapolating for twenty-two years and the page finally says so.

Then the pages go blank again. All of them. Including the ones he drew. `ending_a`.

### Ending B — "DO NOT FORCE" (the refusal)

The player walks out and does not come back. The camera holds on the house from the treeline for
ninety seconds while the sky greys. Nothing happens. Nothing has ever happened here.
Buses at nine. `ending_b`. Bleak, honest, and correct — but it is not the true one.

### Ending C — "SOME ASSEMBLY REQUIRED" (the ending)

There is one part in the world that fits a child-sized dotted outline.

The player sits down.

That is the last thing the player does in this game: they sit in the small chair, at the table,
in the finished house, and the game does not tell them to. There is no prompt. It is available
from the moment the house is done and most players will find it because seven nights have taught
them to look for the slot that fits.

When he sits, the mask comes off. The camera does not show his face — the mask simply enters the
frame, set down on the table, glazed, cracked, two holes too far apart. His hands are on the
table and they are ruined.

The manual is open beside it, blank, and it stays blank, because she died in 1962 and she never
drew what comes after the house is finished.

Outside, at 6:15, the first bus turns off the county road. You can hear it through the wall,
because he built the wall correctly, and a correctly built wall carries sound from a road exactly
this way.

Kids. A lot of them. Screaming the good way.

He does not get up.

**Last panel.** Over black, the game draws one final diagram in Marit's confident single-stroke
hand — the finished house, in three-quarter elevation, exactly as the player built it, with a
tick beside it. And in the corner, where the maker's mark goes on every page in the game:

**VIK & SØN**

Fade. `ending_c`. Achievement name, in the flat-pack voice: **"NO PARTS REMAINING."**

---

## 9. TITLE CARDS & CHAPTER NAMES

Rendered by `Menu.js` / `HUD.js` at `night:begin` in the manual's typeface — thin black Helvetica-alike on flat white, one `#d92b2b` accent rule, held for 2.4 s with no music. The tonal knife-twist against the wet dark is the entire point.

| # | Title card | Sub-line (small, bottom-left) |
|---|---|---|
| **NIGHT ONE** | **FOUNDATION (A)** | *Check contents before beginning.* |
| **NIGHT TWO** | **UPRIGHTS (B ×4) — SUPPORT WHILE FIXING** | *Two persons recommended.* |
| **NIGHT THREE** | **DO NOT OVERTIGHTEN** | *Damage caused this way is not covered.* |
| **NIGHT FOUR** | **IF PARTS ARE MISSING, DO NOT RETURN TO STORE** | *Obtain locally.* |
| **NIGHT FIVE** | **THIS STEP REQUIRES TWO PERSONS** | — |
| **NIGHT SIX** | **SOLD SEPARATELY** | *Illustration may differ from product.* |
| **NIGHT SEVEN** | **SOME ASSEMBLY REQUIRED** | — |

Night Five and Night Seven have no sub-line. The player will notice. Nights One through Four
have a joke at the bottom of the card and then, twice, there just isn't one, and the silence
where the joke goes does more work than the joke ever did.

---

## APPENDIX — STORY FLAGS & BEAT IDS (canonical, for `NightManager` + `Script.js`)

```
storyFlags:
  sawIntroPanel, foundShim, robinSuspicious, robinDismissed, stoleHinges,
  firstBlood, sawSecondFigure, riggedCounterweight, foundRuinAnchors,
  robinSaw, bevRemembered, manualBlank, ending_a | ending_b | ending_c

story:beat ids (in order):
  n1_thumbs_up, n2_robin_hears, n3_not_believed, n4_dale,
  n5_two_persons, n6_robin_inside, n6_bev_remembers, n7_final
```

**Non-negotiables for every other agent.** No narrator. No lore collectibles. No text in the
world except article numbers and the word HJEM. The slasher never speaks. The campers are never
stupid. The manual is the only comedian and it stops being funny on Night Four.
